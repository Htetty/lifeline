/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as callerLocation from "../callerLocation.js";
import type * as callerUpdates from "../callerUpdates.js";
import type * as calls from "../calls.js";
import type * as exercise from "../exercise.js";
import type * as incidents from "../incidents.js";
import type * as lib from "../lib.js";
import type * as linking from "../linking.js";
import type * as planner from "../planner.js";
import type * as planning from "../planning.js";
import type * as seedData from "../seedData.js";
import type * as tripMath from "../tripMath.js";
import type * as trips from "../trips.js";
import type * as vehicles from "../vehicles.js";
import type * as waterReports from "../waterReports.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  callerLocation: typeof callerLocation;
  callerUpdates: typeof callerUpdates;
  calls: typeof calls;
  exercise: typeof exercise;
  incidents: typeof incidents;
  lib: typeof lib;
  linking: typeof linking;
  planner: typeof planner;
  planning: typeof planning;
  seedData: typeof seedData;
  tripMath: typeof tripMath;
  trips: typeof trips;
  vehicles: typeof vehicles;
  waterReports: typeof waterReports;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
