import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "isolated-fixture-only";
const dispatcherToken = "isolated-dispatcher-only";
const update = (callId: string, turnId = "ink-1", sequence = 1) => ({
  secret, callId, turnId, sequence, fingerprint: `fingerprint-${turnId}`,
  source: "live_demo" as const, reportedAddress: "Fictional Mission Valley building",
  peopleCount: 3, reportedPosition: "upstairs", hazards: [], summary: "Three upstairs",
  transcript: "Caller: Three upstairs", response: {next_question: null, extraction: null},
});

beforeEach(() => { process.env.BACKEND_SECRET = secret; process.env.DISPATCHER_TOKEN = dispatcherToken; });

describe("atomic voice ingestion", () => {
  test("retries create one incident and corrections preserve evidence", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.calls.startVoiceCall, {secret, callId:"a"});
    const first = await t.mutation(api.calls.upsertFromCall, update("a"));
    expect(await t.mutation(api.calls.upsertFromCall, update("a"))).toEqual(first);
    const corrected = await t.mutation(api.calls.upsertFromCall, {...update("a","ink-2",2),
      reportedAddress:"Fictional Hotel Circle North", peopleCount:4, locationChanged:true,
      transcript:"Caller: Three upstairs\nCaller: Actually four at Hotel Circle North"});
    expect(corrected.incident.incidentId).toEqual(first.incident.incidentId);
    const rows = await t.run(ctx => ctx.db.query("incidents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({peopleCount:4,reportedAddress:"Fictional Hotel Circle North",locationVerified:false});
    expect(rows[0].transcript).toContain("Three upstairs");
    expect(await t.run(ctx => ctx.db.query("voiceTurns").collect())).toHaveLength(2);
  });

  test("rejects wrong secrets, collisions and out-of-order turns; isolates calls", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.calls.startVoiceCall,{secret:"wrong",callId:"a"})).rejects.toThrow();
    for (const callId of ["a","b"]) await t.mutation(api.calls.startVoiceCall,{secret,callId});
    await expect(t.mutation(api.calls.upsertFromCall, update("a","ink-2",2))).rejects.toThrow("Out of order");
    const a = await t.mutation(api.calls.upsertFromCall,update("a"));
    const b = await t.mutation(api.calls.upsertFromCall,update("b"));
    expect(a.incident.incidentId).not.toEqual(b.incident.incidentId);
    await expect(t.mutation(api.calls.upsertFromCall,{...update("a"),fingerprint:"changed"})).rejects.toThrow("identity conflict");
    await expect(t.query(api.calls.turnReceipt,{secret,callId:"a",turnId:"ink-1",sequence:2,fingerprint:"fingerprint-ink-1"})).rejects.toThrow();
  });

  test("missing extraction retains known values; hangup leaves incident open",async () => {
    const t = convexTest(schema,modules);
    await t.mutation(api.calls.startVoiceCall,{secret,callId:"a"});
    await t.mutation(api.calls.upsertFromCall,update("a"));
    await t.mutation(api.calls.upsertFromCall,{...update("a","ink-2",2),peopleCount:null,reportedAddress:null});
    await t.mutation(api.calls.callEnded,{secret,callId:"a"});
    const row=await t.run(ctx=>ctx.db.query("incidents").first());
    expect(row).toMatchObject({peopleCount:3,callConnected:false,status:"needs_review"});
    await expect(t.mutation(api.calls.upsertFromCall,update("a","ink-3",3))).rejects.toThrow("not active");
    expect(await t.mutation(api.calls.upsertFromCall,update("a"))).toBeTruthy();
  });
});

describe("approved announcement lifecycle", () => {
  async function assigned() {
    const t=convexTest(schema,modules);
    await t.mutation(api.exercise.ensureSeeded,{dispatcherToken});
    await t.mutation(api.calls.startVoiceCall,{secret,callId:"a"});
    const result=await t.mutation(api.calls.upsertFromCall,update("a"));
    const incidentId=result.incident.incidentId;
    const team=await t.run(ctx=>ctx.db.query("teams").first());
    await expect(t.mutation(api.incidents.assignTeam,{dispatcherToken,incidentId,teamId:team!._id})).rejects.toThrow("Confirm the location");
    // Before confirmation the caller may only hear that their details reached the dispatcher.
    const types = async () => (await t.query(api.calls.pendingEvents,{secret,callId:"a"})).map((e:{type:string})=>e.type);
    expect(await types()).toEqual(["details_received"]);
    await t.mutation(api.incidents.verifyLocation,{dispatcherToken,incidentId,latitude:32.76,longitude:-117.16});
    await t.mutation(api.incidents.assignTeam,{dispatcherToken,incidentId,teamId:team!._id});
    return {t,incidentId};
  }

  test("only matching call can ack, ack retries are idempotent",async()=>{
    const {t}=await assigned();
    const events=await t.query(api.calls.pendingEvents,{secret,callId:"a"});
    expect(events).toHaveLength(1);
    expect(events[0].teamName).toBeTruthy();
    const eventId=events[0]._id;
    expect(await t.mutation(api.calls.markAnnounced,{secret,callId:"other",eventId})).toEqual({acknowledged:false});
    for(let i=0;i<2;i++) expect(await t.mutation(api.calls.markAnnounced,{secret,callId:"a",eventId})).toEqual({acknowledged:true});
    expect(await t.query(api.calls.pendingEvents,{secret,callId:"a"})).toEqual([]);
  });

  test("withdrawal and new dispatcher status invalidate old updates",async()=>{
    const {t,incidentId}=await assigned();
    const [old]=await t.query(api.calls.pendingEvents,{secret,callId:"a"});
    await t.mutation(api.incidents.setStatus,{dispatcherToken,incidentId,status:"awaiting_assignment"});
    // The withdrawn assignment is never spoken; the caller hears that a new team is being arranged.
    const pending = await t.query(api.calls.pendingEvents,{secret,callId:"a"});
    expect(pending.map((e:{type:string})=>e.type)).toEqual(["assignment_changed"]);
    expect(await t.mutation(api.calls.markAnnounced,{secret,callId:"a",eventId:old._id})).toEqual({acknowledged:false});
  });

  test("caller location correction invalidates the old destination announcement",async()=>{
    const {t}=await assigned();
    await t.mutation(api.calls.upsertFromCall,{...update("a","ink-2",2),reportedAddress:"Different fictional building",locationChanged:true});
    expect(await t.query(api.calls.pendingEvents,{secret,callId:"a"})).toEqual([]);
  });

  test("disconnected call has no speakable announcements, incident remains assigned",async()=>{
    const {t}=await assigned();
    await t.mutation(api.calls.callEnded,{secret,callId:"a"});
    expect(await t.query(api.calls.pendingEvents,{secret,callId:"a"})).toEqual([]);
    expect(await t.query(api.calls.statusForCall,{secret,callId:"a"})).toMatchObject({status:"assigned",callConnected:false});
  });

  test("explicit replay can read a completed update only while current and connected",async()=>{
    const {t,incidentId}=await assigned();
    const [event]=await t.query(api.calls.pendingEvents,{secret,callId:"a"});
    await t.mutation(api.calls.markAnnounced,{secret,callId:"a",eventId:event._id});
    expect(await t.query(api.calls.pendingEvents,{secret,callId:"a"})).toEqual([]);
    expect(await t.query(api.calls.currentAnnouncement,{secret,callId:"a"})).toMatchObject({_id:event._id,teamName:event.teamName});
    expect(await t.query(api.calls.currentAnnouncement,{secret,callId:"other"})).toBeNull();
    await expect(t.query(api.calls.currentAnnouncement,{secret:"wrong",callId:"a"})).rejects.toThrow();
    await t.mutation(api.incidents.setStatus,{dispatcherToken,incidentId,status:"awaiting_assignment"});
    // The withdrawn assignment never comes back, by id or as "the latest update" ...
    expect(await t.query(api.calls.currentAnnouncement,{secret,callId:"a",eventId:event._id})).toBeNull();
    // ... the truthful replay is dev's change notice, which names no team.
    const changed=await t.query(api.calls.currentAnnouncement,{secret,callId:"a"});
    expect(changed).toMatchObject({type:"assignment_changed"});
    expect(changed!.text).not.toContain(event.teamName!);
    await t.mutation(api.calls.callEnded,{secret,callId:"a"});
    expect(await t.query(api.calls.currentAnnouncement,{secret,callId:"a"})).toBeNull();
  });

  test("replay picks a status update, by id any current update, with its saved witness wording",async()=>{
    const t=convexTest(schema,modules);
    await t.mutation(api.exercise.ensureSeeded,{dispatcherToken});
    await t.mutation(api.calls.startVoiceCall,{secret,callId:"w"});
    const result=await t.mutation(api.calls.upsertFromCall,{...update("w"),callerRole:"witness"});
    const incidentId=result.incident.incidentId;
    // Only "details received" so far: not a status answer for "which team?".
    expect(await t.query(api.calls.currentAnnouncement,{secret,callId:"w"})).toBeNull();
    await t.mutation(api.incidents.sendCallerMessage,{dispatcherToken,incidentId,message:"Move to the top floor."});
    const [message]=(await t.query(api.calls.pendingEvents,{secret,callId:"w"})).filter((e:{type:string})=>e.type==="dispatcher_message");
    expect(await t.query(api.calls.currentAnnouncement,{secret,callId:"w",eventId:message._id})).toMatchObject({_id:message._id});
    expect(await t.query(api.calls.currentAnnouncement,{secret,callId:"other",eventId:message._id})).toBeNull();
    const team=await t.run(ctx=>ctx.db.query("teams").first());
    await t.mutation(api.incidents.verifyLocation,{dispatcherToken,incidentId,latitude:32.76,longitude:-117.16});
    await t.mutation(api.incidents.assignTeam,{dispatcherToken,incidentId,teamId:team!._id});
    const replay=await t.query(api.calls.currentAnnouncement,{secret,callId:"w"});
    expect(replay).toMatchObject({type:"assignment_approved"});
    expect(replay!.text).toContain("the people you reported");
    expect(replay!.text).toContain(team!.name);
  });
});

describe("open demo mode", () => {
  test("dashboard functions need no passcode when DISPATCHER_TOKEN is unset", async () => {
    delete process.env.DISPATCHER_TOKEN;
    const t = convexTest(schema, modules);
    await t.mutation(api.exercise.ensureSeeded, {});
    const state = await t.query(api.exercise.get, {});
    expect(state?.incidents.length).toBeGreaterThan(0);
    process.env.DISPATCHER_TOKEN = dispatcherToken;
    await expect(t.query(api.exercise.get, {})).rejects.toThrow("passcode");
  });
});
