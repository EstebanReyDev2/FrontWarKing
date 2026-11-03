import { maps } from "@openfront/engine-api/game/Maps.gen";
import { describe, expect, it } from "vitest";
import { allLobbyMaps, curatedMaps } from "../../src/client/CuratedMaps";

describe("curated lobby maps", () => {
  it("contains unique maps that exist in Maps.gen", () => {
    expect(curatedMaps.length).toBeGreaterThan(0);
    expect(new Set(curatedMaps.map(({ map }) => map)).size).toBe(
      curatedMaps.length,
    );
    for (const { map } of curatedMaps) {
      expect(maps.some((info) => info.type === map)).toBe(true);
    }
  });

  it("keeps the curated list medium and expands to the complete map catalog", () => {
    expect(curatedMaps).toHaveLength(15);
    expect(curatedMaps.map(({ map }) => map)).not.toContain("World");
    expect(allLobbyMaps).toHaveLength(135);
  });
});
