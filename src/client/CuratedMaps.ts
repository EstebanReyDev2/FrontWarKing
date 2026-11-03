import { GameMapType, maps } from "@openfront/engine-api/game/Maps.gen";

export interface CuratedMap {
  map: GameMapType;
  reason: string;
}

// Normal map size only; omit the compact modifier and the oversized World map.
// Favor recognizable, geographically varied regions with multiple approaches.
export const curatedMaps: readonly CuratedMap[] = [
  {
    map: GameMapType.Africa,
    reason: "Continente amplio con costas y rutas interiores.",
  },
  {
    map: GameMapType.Aegean,
    reason: "Región mediterránea con islas y pasos disputables.",
  },
  {
    map: GameMapType.Asia,
    reason: "Variedad de fronteras y accesos entre regiones.",
  },
  {
    map: GameMapType.Australia,
    reason: "Escala regional clara con posiciones diferenciadas.",
  },
  {
    map: GameMapType.Balkans,
    reason: "Mapa regional compacto con varios corredores.",
  },
  {
    map: GameMapType.Caribbean,
    reason: "Archipiélago que ofrece rutas marítimas alternativas.",
  },
  {
    map: GameMapType.CentralAmerica,
    reason: "Istmo con pasos estratégicos y frentes legibles.",
  },
  {
    map: GameMapType.China,
    reason: "Región continental con fronteras y accesos variados.",
  },
  {
    map: GameMapType.EastAsia,
    reason: "Combina costa e interior sin usar el mapa mundial.",
  },
  {
    map: GameMapType.Europe,
    reason: "Región central con múltiples vecinos y rutas.",
  },
  {
    map: GameMapType.Japan,
    reason: "Cadena de islas con alternativas de expansión.",
  },
  {
    map: GameMapType.MiddleEast,
    reason: "Cruce regional entre rutas terrestres y costeras.",
  },
  {
    map: GameMapType.NorthAmerica,
    reason: "Continente con variedad de costas y pasos interiores.",
  },
  {
    map: GameMapType.Oceania,
    reason: "Distribución insular distinta de los mapas continentales.",
  },
  {
    map: GameMapType.SouthAmerica,
    reason: "Eje norte-sur con costa y corredores interiores.",
  },
];

export const allLobbyMaps: readonly GameMapType[] = maps.map((map) => map.type);
