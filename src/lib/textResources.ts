type DescriptionMap = Record<string, string>;

export type BhavaDescription = {
  title: string;
  body: string;
};

export type BhavaMap = Record<string, BhavaDescription>;

export type ChartTextResources = {
  ascSignDescriptions: DescriptionMap;
  lagneshaDescriptions: DescriptionMap;
  lagneshaHouseDescriptions: DescriptionMap;
  atmaKarakaDescriptions: DescriptionMap;
  daraKarakaDescriptions: DescriptionMap;
  suryaBhavas: BhavaMap;
  chandraBhavas: BhavaMap;
  guruBhavas: BhavaMap;
  budhaBhavas: BhavaMap;
  shukraBhavas: BhavaMap;
  shaniBhavas: BhavaMap;
  mangalaBhavas: BhavaMap;
  ketuBhavas: BhavaMap;
  rahuBhavas: BhavaMap;
};

export type KarakaDescriptions = {
  atma: DescriptionMap;
  dara: DescriptionMap;
};

let chartTextResourcesPromise: Promise<ChartTextResources> | null = null;
let chartTextResourcesCache: ChartTextResources | null = null;

let karakaDescriptionsPromise: Promise<KarakaDescriptions> | null = null;
let karakaDescriptionsCache: KarakaDescriptions | null = null;

function toDescriptionMap(payload: unknown): DescriptionMap {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as DescriptionMap;
  }
  return {};
}

function toBhavaMap(payload: unknown): BhavaMap {
  if (!Array.isArray(payload)) {
    return {};
  }
  return payload.reduce<BhavaMap>((acc, item) => {
    if (!item || typeof item !== "object") {
      return acc;
    }
    const values = Object.values(item);
    const house = values.find((value) => typeof value === "number") as number | undefined;
    const stringValues = values.filter((value) => typeof value === "string") as string[];
    if (!house) {
      return acc;
    }
    const title = stringValues[0] ?? "";
    const body = stringValues[1] ?? title;
    acc[String(house)] = { title, body };
    return acc;
  }, {});
}

export function loadChartTextResources(): Promise<ChartTextResources> {
  if (chartTextResourcesCache) {
    return Promise.resolve(chartTextResourcesCache);
  }
  if (!chartTextResourcesPromise) {
    chartTextResourcesPromise = Promise.all([
      import("../../data/sign_descriptions_ru.json"),
      import("../../data/lagnesha_descriptions_ru.json"),
      import("../../data/lagnesha_house_descriptions_ru.json"),
      import("../../data/atma_karaka_descriptions_ru.json"),
      import("../../data/dara_karaka_descriptions_ru.json"),
      import("../../data/surya_bhavas_full.json"),
      import("../../data/chandra_bhavas_full.json"),
      import("../../data/guru_bhavas_by_house.json"),
      import("../../data/mercury_bhavas_template.json"),
      import("../../data/venus_bhavas_template.json"),
      import("../../data/saturn_bhavas_template.json"),
      import("../../data/mars_bhavas_template.json"),
      import("../../data/rahu_bhavas_template.json"),
      import("../../data/ketu_bhavas_template.json"),
    ]).then(([
      signModule,
      lagneshaModule,
      lagneshaHouseModule,
      atmaModule,
      daraModule,
      suryaModule,
      chandraModule,
      guruModule,
      mercuryModule,
      venusModule,
      saturnModule,
      marsModule,
      rahuModule,
      ketuModule,
    ]) => {
      const resources: ChartTextResources = {
        ascSignDescriptions: toDescriptionMap(signModule.default),
        lagneshaDescriptions: toDescriptionMap(lagneshaModule.default),
        lagneshaHouseDescriptions: toDescriptionMap(lagneshaHouseModule.default),
        atmaKarakaDescriptions: toDescriptionMap(atmaModule.default),
        daraKarakaDescriptions: toDescriptionMap(daraModule.default),
        suryaBhavas: toBhavaMap(suryaModule.default),
        chandraBhavas: toBhavaMap(chandraModule.default),
        guruBhavas: toBhavaMap(guruModule.default),
        budhaBhavas: toBhavaMap(mercuryModule.default),
        shukraBhavas: toBhavaMap(venusModule.default),
        shaniBhavas: toBhavaMap(saturnModule.default),
        mangalaBhavas: toBhavaMap(marsModule.default),
        ketuBhavas: toBhavaMap(ketuModule.default),
        rahuBhavas: toBhavaMap(rahuModule.default),
      };
      chartTextResourcesCache = resources;
      return resources;
    });
  }
  return chartTextResourcesPromise;
}

export function loadKarakaDescriptions(): Promise<KarakaDescriptions> {
  if (karakaDescriptionsCache) {
    return Promise.resolve(karakaDescriptionsCache);
  }
  if (!karakaDescriptionsPromise) {
    karakaDescriptionsPromise = Promise.all([
      import("../../data/atma_karaka_descriptions_ru.json"),
      import("../../data/dara_karaka_descriptions_ru.json"),
    ]).then(([atmaModule, daraModule]) => {
      const descriptions: KarakaDescriptions = {
        atma: toDescriptionMap(atmaModule.default),
        dara: toDescriptionMap(daraModule.default),
      };
      karakaDescriptionsCache = descriptions;
      return descriptions;
    });
  }
  return karakaDescriptionsPromise;
}
