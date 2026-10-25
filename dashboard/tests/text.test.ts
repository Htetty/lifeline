import { describe, expect, it } from "vitest";
import { capitalize, capitalizeEach } from "../src/lib/text";

describe("capitalize", () => {
  it("raises the first letter of a lower-case label", () => {
    expect(capitalize("the apartments on Camino de la Reina")).toBe("The apartments on Camino de la Reina");
    expect(capitalize("in the attic")).toBe("In the attic");
  });

  it("looks past leading quotes, brackets and spaces", () => {
    expect(capitalize('"low building behind the gas station"')).toBe('"Low building behind the gas station"');
    expect(capitalize("  (unclear) roof")).toBe("  (Unclear) roof");
    expect(capitalize("“we're on the roof”")).toBe("“We're on the roof”");
  });

  it("leaves text that already starts with a capital, digit or symbol alone", () => {
    expect(capitalize("Handlery Hotel")).toBe("Handlery Hotel");
    expect(capitalize("2150 Camino del Rio North")).toBe("2150 Camino del Rio North");
  });

  it("passes empty values through", () => {
    expect(capitalize("")).toBe("");
    expect(capitalize(null)).toBeNull();
    expect(capitalize(undefined)).toBeUndefined();
  });

  it("capitalizes each label in a list", () => {
    expect(capitalizeEach(["medical need", "on a roof"])).toEqual(["Medical need", "On a roof"]);
  });
});
