import React, { useEffect, useRef, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { finalStrength, type Inputs, type FuncRole, type SignFriendLevel } from "../lib/strength";
import atmaKarakaDescriptions from "../../data/atma_karaka_descriptions_ru.json";
import daraKarakaDescriptions from "../../data/dara_karaka_descriptions_ru.json";
import { getAscCompatibility } from "../lib/synastry-compat";
import { getAscCompatScore } from "../synastry/ascCompatScores";
import { scoreSynastry, getPlanetSignCode, getPlanetHouse, affinityBySignDistance, getAscSignCode, scoreNumerology } from "../synastry/scoring";
import { describeMoonMoon, moonMoonVerdict, describeSunSun, sunSunVerdict, describeSunMoon, sunMoonVerdict, describeVenusMars, marsVenusVerdict } from "../synastry/synastry_texts";
import { WEIGHTS } from "../synastry/weights";
import { applyKujaPenaltySimple } from "../synastry/kuja_simple";
import { analyzeKujaDosha, SIGN_NAMES_RU } from "../synastry/kuja";
import { computeDirectionalSynastry, adjustSunMoonRaw } from "../synastry/directionalSummary";
import { computePair } from "../numerology/dirCompat/compute";
import { getExpressionCompatByDate } from "../numerology/exprDate/getExpressionByDate";
import { formatOverlayBlock, type NameForms } from "../synastry/overlayFormat";

type NameCaseForms = {
  nominative?: string;
  genitive?: string;
  dative?: string;
};

type ProfileSnapshot = {
  personName?: string;
  lastName?: string;
  birth?: string;
  gender?: "male" | "female";
  selectedCity?: string;
  cityNameRu?: string;
  cityQuery?: string;
  ascSign?: string;
  mainPhoto?: string | null;
  smallPhotos?: (string | null)[];
  nameNom?: string;
  nameGen?: string;
  nameDat?: string;
  nameCases?: NameCaseForms;
};

type ChartPayload = Record<string, unknown> | null;

type ProfileState = {
  profile: ProfileSnapshot | null;
  ascSign: string | null;
  chart: ChartPayload;
  screenshotUrl: string | null;
  loadedFromFile?: boolean; // флаг: данные загружены из файла (не брать fallback из кэша)
};

const SAVED_CHART_KEY = "synastry_saved_chart_data";
const STORAGE_KEY = "synastry_ui_histtz_v2";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractProfileSnapshot(raw: unknown): ProfileSnapshot | null {
  if (!isRecord(raw)) {
    return null;
  }
  
  // Определяем источник: либо raw.profile, либо сам raw
  const source: Record<string, unknown> = isRecord(raw.profile) ? raw.profile : raw;

  const pickString = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  };

  const rawNameCases = (() => {
    const direct = source["nameCases"];
    if (isRecord(direct)) return direct;
    const snake = source["name_cases"];
    if (isRecord(snake)) return snake;
    return null;
  })();

  const nameCases: NameCaseForms | undefined = rawNameCases ? {
    nominative: pickString(rawNameCases["nominative"]),
    genitive: pickString(rawNameCases["genitive"]),
    dative: pickString(rawNameCases["dative"]),
  } : undefined;

  const nameNom = pickString(source["nameNom"] ?? source["name_nom"] ?? nameCases?.nominative);
  const nameGen = pickString(source["nameGen"] ?? source["name_gen"] ?? source["personNameGen"] ?? nameCases?.genitive);
  const nameDat = pickString(source["nameDat"] ?? source["name_dat"] ?? source["personNameDat"] ?? nameCases?.dative);
  
  // Явно маппим все поля, чтобы не подмешивались лишние
  const result: ProfileSnapshot = {
    personName: typeof source.personName === 'string' ? source.personName : undefined,
    lastName: typeof source.lastName === 'string' ? source.lastName : undefined,
    birth: typeof source.birth === 'string' ? source.birth : undefined,
    gender: (source.gender === 'male' || source.gender === 'female') ? source.gender : undefined,
    selectedCity: typeof source.selectedCity === 'string' ? source.selectedCity : undefined,
    cityNameRu: typeof source.cityNameRu === 'string'
      ? source.cityNameRu
      : (typeof source.cityQuery === 'string' ? source.cityQuery : undefined),
    cityQuery: typeof source.cityQuery === 'string' ? source.cityQuery : undefined,
    ascSign: typeof source.ascSign === 'string' ? source.ascSign : undefined,
    mainPhoto: typeof source.mainPhoto === 'string' ? source.mainPhoto : (source.mainPhoto === null ? null : undefined),
    smallPhotos: Array.isArray(source.smallPhotos) ? source.smallPhotos as (string | null)[] : undefined,
    nameNom,
    nameGen,
    nameDat,
    nameCases,
  };
  
  return result;
}

function extractChartScreenshot(chartValue: unknown): string | null {
  if (!isRecord(chartValue)) return null;
  if (typeof chartValue.screenshotUrl === "string") {
    return chartValue.screenshotUrl;
  }
  if (typeof chartValue.screenshot === "string") {
    return chartValue.screenshot;
  }
  // Check common meta container
  const meta = chartValue.meta;
  if (isRecord(meta)) {
    if (typeof meta.screenshotUrl === "string") return meta.screenshotUrl;
    if (typeof meta.screenshot === "string") return meta.screenshot;
  }
  // Also handle nested structures: { chart: { screenshotUrl: ... } }
  const nested = chartValue.chart;
  if (isRecord(nested)) {
    if (typeof nested.screenshotUrl === "string") return nested.screenshotUrl;
    if (typeof nested.screenshot === "string") return nested.screenshot;
    const nestedMeta = (nested as any).meta;
    if (isRecord(nestedMeta)) {
      if (typeof nestedMeta.screenshotUrl === "string") return nestedMeta.screenshotUrl;
      if (typeof nestedMeta.screenshot === "string") return nestedMeta.screenshot;
    }
  }
  return null;
}

function extractAscSignFromChart(chartValue: unknown): string | null {
  if (!isRecord(chartValue)) return null;
  
  const ascendant = chartValue.ascendant;
  if (isRecord(ascendant) && typeof ascendant.sign === "string") {
    return SIGN_NAMES_RU[ascendant.sign] ?? ascendant.sign;
  }
  
  const houses = chartValue.houses;
  if (Array.isArray(houses)) {
    for (const house of houses) {
      if (!isRecord(house)) continue;
      const houseNumber = typeof house.house === "number" ? house.house : Number(house.house);
      const signCode = typeof house.sign === "string" ? house.sign : "";
      if (houseNumber === 1 && signCode) {
        return SIGN_NAMES_RU[signCode] ?? signCode;
      }
    }
  }
  
  const layout = chartValue.north_indian_layout;
  if (isRecord(layout) && Array.isArray(layout.boxes)) {
    for (const box of layout.boxes) {
      if (!isRecord(box)) continue;
      const houseNumber = typeof box.house === "number" ? box.house : Number(box.house);
      const signCode = typeof box.sign === "string" ? box.sign : "";
      if (houseNumber === 1 && signCode) {
        return SIGN_NAMES_RU[signCode] ?? signCode;
      }
    }
  }
  
  return null;
}

function calculateAge(birthIso: string | undefined): string | null {
  if (!birthIso) return null;
  const parsed = new Date(birthIso);
  if (Number.isNaN(parsed.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - parsed.getFullYear();
  const monthDiff = now.getMonth() - parsed.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < parsed.getDate())) {
    age -= 1;
  }
  return age >= 0 ? `${age} лет` : null;
}

function formatBirthDate(birthIso: string | undefined): string | null {
  if (!birthIso) return null;
  const parsed = new Date(birthIso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
}

function formatBirthTime(birthIso: string | undefined): string | null {
  if (!birthIso) return null;
  const parsed = new Date(birthIso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function readStoredAscSign(): string | null {
  try {
    const raw = localStorage.getItem(SAVED_CHART_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const chartValue = parsed.chart ?? null;
    const ascFromChart = extractAscSignFromChart(chartValue);
    if (ascFromChart) return ascFromChart;

    const profileValue = parsed.profile ?? null;
    if (isRecord(profileValue) && typeof profileValue.ascSign === "string") {
      return profileValue.ascSign;
    }

    return null;
  } catch (error) {
    console.warn("Failed to read stored ascendant sign", error);
    return null;
  }
}

function resolveAscSign(profile: ProfileSnapshot | null, chart: ChartPayload, fromFile?: boolean): string | null {
  if (profile?.ascSign && profile.ascSign.trim()) {
    return profile.ascSign.trim();
  }
  const fromChart = extractAscSignFromChart(chart);
  if (fromChart) return fromChart;
  
  // Если данные из файла, НЕ читать из localStorage (не смешивать)
  if (fromFile) {
    return null;
  }
  
  const storedAsc = readStoredAscSign();
  if (storedAsc) return storedAsc;
  
  return null;
}

function buildProfileState(profile: ProfileSnapshot | null, chart: ChartPayload, loadedFromFile?: boolean): ProfileState {
  const screenshotUrl = extractChartScreenshot(chart);
  const ascSign = resolveAscSign(profile, chart, loadedFromFile);
  return {
    profile,
    ascSign,
    chart,
    screenshotUrl,
    loadedFromFile,
  };
}

// Вспомогательная функция для чтения булевых флагов/меток из объекта планеты без пересчёта
function readFlag(obj: unknown, keys: string[], markerSymbol?: string, markers?: unknown): boolean {
  if (isRecord(obj)) {
    if (isRecord(obj.flags)) {
      for (const k of keys) {
        const v = obj.flags[k];
        if (typeof v === 'boolean') return v;
      }
    }
    for (const k of keys) {
      const v = (obj as any)[k];
      if (typeof v === 'boolean') return v;
    }
    if (typeof (obj as any).dignity === 'string') {
      const d = (obj as any).dignity as string;
      if (keys.includes('isExalt') && d === 'exalt') return true;
      if (keys.includes('isDebil') && d === 'debil') return true;
      if (keys.includes('isMoola') && d === 'moola') return true;
      if (keys.includes('isOwn') && d === 'own') return true;
    }
  }
  const m = Array.isArray(markers) ? markers as unknown[] : [];
  if (markerSymbol && m.includes(markerSymbol)) return true;
  return false;
}

// Преобразование объекта планеты в Inputs для finalStrength, используя только готовые флаги из chart
function planetToInputs(chart: ChartPayload, planetCode: string): Inputs | null {
  // Поддержка двух структур: chart.planets и chart.chart.planets (старый формат из Supabase)
  let planets: any[] | undefined;
  
  if (isRecord(chart)) {
    if (Array.isArray((chart as any).planets)) {
      planets = (chart as any).planets;
    } else if (isRecord((chart as any).chart) && Array.isArray(((chart as any).chart as any).planets)) {
      planets = ((chart as any).chart as any).planets;
    }
  }
  
  if (!planets) return null;
  
  const p = planets.find((pl) => isRecord(pl) && typeof pl.name === 'string' && pl.name === planetCode);
  if (!p || !isRecord(p)) return null;

  const markers = isRecord(p) && Array.isArray((p as any).markers) ? (p as any).markers
               : isRecord(p) && Array.isArray((p as any).markersSymbols) ? (p as any).markersSymbols
               : isRecord(p) && Array.isArray((p as any).tags) ? (p as any).tags
               : [];

  const basePercent = Math.max(0, Math.min(100, Math.round(((p as any).house_strength ?? 0) * 100)));

  let signFriendLevel: SignFriendLevel = 'neutral';
  const rel = (p as any).sign_friend_level ?? (p as any).signFriendLevel ?? (p as any).relation_level;
  if (rel === 'friend' || rel === 'neutral' || rel === 'enemy') signFriendLevel = rel;

  let funcRole: FuncRole = '0';
  const role = (p as any).func_role ?? (p as any).functional_role;
  if (role === '++' || role === '+' || role === '0' || role === '-' || role === '--') funcRole = role;

  const groups = isRecord(p) && isRecord((p as any).house_groups) ? (p as any).house_groups as Record<string, unknown> : {};
  const isTrikona = !!(groups.trikona ?? (p as any).is_trikona);
  const isKendra =  !!(groups.kendra  ?? (p as any).is_kendra);
  const isUpachaya = !!(groups.upachaya ?? (p as any).is_upachaya);
  const isDusthana8or12 = !!(groups.dusthana8or12 ?? (p as any).is_dusthana8or12);

  const inputs: Inputs = {
    basePercent,
    isExalt: readFlag(p, ['isExalt', 'exalt'], '↑', markers),
    isDebil: readFlag(p, ['isDebil', 'debil'], '↓', markers),
    isMoola: readFlag(p, ['isMoola', 'moola'], undefined, markers),
    isOwn:   readFlag(p, ['isOwn', 'own'], '⌂', markers),
    signFriendLevel,
    isTrikona,
    isKendra,
    isUpachaya,
    isDusthana8or12,
    hasDigbala: readFlag(p, ['hasDigbala', 'digbala'], '□', markers),
    funcRole,
    aspectBonusSum: Number((p as any).aspect_bonus_sum ?? 0) || 0,
    conjunctionBonusSum: Number((p as any).conjunction_bonus_sum ?? 0) || 0,
    isSuperStrong: readFlag(p, ['isSuperStrong', 'super_strong'], '☼', markers),
    isCombust: readFlag(p, ['isCombust', 'combust'], '●', markers),
    lostGrahaYuddha: readFlag(p, ['lostGrahaYuddha', 'lost_war'], 'Ø', markers),
    borderPenalty: Number((p as any).border_penalty ?? 0) || 0,
  };

  return inputs;
}

// Получить объект планеты
function getPlanetObject(chart: ChartPayload, planetCode: string): Record<string, unknown> | null {
  // Поддержка двух структур: chart.planets и chart.chart.planets
  let planets: any[] | undefined;
  
  if (isRecord(chart)) {
    if (Array.isArray((chart as any).planets)) {
      planets = (chart as any).planets;
    } else if (isRecord((chart as any).chart) && Array.isArray(((chart as any).chart as any).planets)) {
      planets = ((chart as any).chart as any).planets;
    }
  }
  
  if (!planets) return null;
  
  const p = planets.find((pl) => isRecord(pl) && typeof (pl as any).name === 'string' && (pl as any).name === planetCode);
  return isRecord(p) ? (p as Record<string, unknown>) : null;
}

// Извлечь строку с символами маркеров для планеты
function getPlanetMarkerSymbols(planet: Record<string, unknown> | null): string {
  if (!planet) return "";
  const rawMarkers = (Array.isArray((planet as any).markersSymbols) ? (planet as any).markersSymbols
                    : Array.isArray((planet as any).markers) ? (planet as any).markers
                    : Array.isArray((planet as any).tags) ? (planet as any).tags
                    : []) as unknown[];
  const fromFlags: string[] = [];
  const pushIf = (cond: boolean, sym: string) => { if (cond && !fromFlags.includes(sym)) fromFlags.push(sym); };
  const flags = isRecord((planet as any).flags) ? ((planet as any).flags as Record<string, unknown>) : {};
  const dignity = typeof (planet as any).dignity === 'string' ? ((planet as any).dignity as string) : '';
  pushIf(Boolean(flags["isExalt"]) || dignity === 'exalt', '↑');
  pushIf(Boolean(flags["isDebil"]) || dignity === 'debil', '↓');
  pushIf(Boolean(flags["isOwn"])   || dignity === 'own',   '⌂');
  pushIf(Boolean(flags["hasDigbala"]) || Boolean((planet as any).hasDigbala), '□');
  pushIf(Boolean(flags["isSuperStrong"]) || Boolean((planet as any).isSuperStrong), '☼');
  pushIf(Boolean(flags["isCombust"]) || Boolean((planet as any).isCombust), '●');
  pushIf(Boolean(flags["lostGrahaYuddha"]) || Boolean((planet as any).lostGrahaYuddha), 'Ø');
  const merged = [...fromFlags, ...rawMarkers.filter((m) => typeof m === 'string') as string[]];
  const uniq: string[] = [];
  for (const s of merged) { if (!uniq.includes(s)) uniq.push(s); }
  return uniq.join(' ');
}

// Короткая расшифровка вклада факторов
function explainInputs(x: Inputs): string[] {
  const parts: string[] = [];
  if (x.isExalt) parts.push('Проявляется: экзальтация (×1.25)');
  else if (x.isMoola) parts.push('Проявляется: мула-трикона (×1.15)');
  else if (x.isOwn) parts.push('Проявляется: свой знак (×1.10)');
  else if (x.signFriendLevel === 'friend') parts.push('Знак дружелюбен (×1.05)');
  else if (x.signFriendLevel === 'enemy') parts.push('Знак враждебен (×0.90)');
  else parts.push('Проявляется: нейтрально (×1.00)');
  if (x.isTrikona) parts.push('Дом: трикона (×1.10)');
  else if (x.isKendra) parts.push('Дом: кендра (×1.06)');
  else if (x.isUpachaya) parts.push('Дом: упачайя (×1.04)');
  if (x.isDusthana8or12) parts.push('Дом: дустхана (8/12) — ограничение (≤×0.92)');
  if (x.hasDigbala) parts.push('Дигбала: есть (×1.10)');
  if (x.funcRole === '++') parts.push('Функциональная роль: очень благ. (+8)');
  else if (x.funcRole === '+') parts.push('Функциональная роль: благ. (+4)');
  else if (x.funcRole === '-') parts.push('Функциональная роль: неблаг. (−4)');
  else if (x.funcRole === '--') parts.push('Функциональная роль: очень неблаг. (−8)');
  if (x.isSuperStrong) parts.push('Сверхсила ☼ от Солнца (+8)');
  else if (x.isCombust) parts.push('Сожжение ● (−8)');
  if (x.lostGrahaYuddha) parts.push('Проигрыш планетной войны Ø (−8)');
  const a = Math.round((x.aspectBonusSum || 0) * 10) / 10;
  const c = Math.round((x.conjunctionBonusSum || 0) * 10) / 10;
  const b = Math.round((x.borderPenalty || 0) * 10) / 10;
  if (a) parts.push(`Сумма аспектов: ${a > 0 ? '+' : ''}${a}`);
  if (c) parts.push(`Сумма соединений: ${c > 0 ? '+' : ''}${c}`);
  if (b) parts.push(`Штраф «на границе»: ${b}`);
  return parts;
}

function thresholdSummary(pct: number): string {
  if (pct >= 75) return 'Сильная, стабильно проявляется и поддерживает отношения.';
  if (pct >= 50) return 'Выше среднего: влияние проявляется, но требует внимания.';
  if (pct >= 25) return 'Ниже среднего: нужна дополнительная поддержка и коррекции.';
  return 'Слабая: стоит усилить практиками и осознанностью.';
}

const PLANET_NAMES_RU: Record<string, string> = {
  Su: "Солнце",
  Mo: "Луна",
  Me: "Меркурий",
  Ve: "Венера",
  Ma: "Марс",
  Ju: "Юпитер",
  Sa: "Сатурн",
  Ra: "Раху",
  Ke: "Кету",
};

const ATMA_KARAKA_DESCRIPTIONS_RU: Record<string, string> = atmaKarakaDescriptions as Record<string, string>;
const DARA_KARAKA_DESCRIPTIONS_RU: Record<string, string> = daraKarakaDescriptions as Record<string, string>;

// Убрать начало описания с названием планеты (например, "Луна: таланты:" -> "таланты:")
function cleanKarakaDescription(text: string, planetName: string): string {
  if (!text) return text;
  // Убираем "Луна: " или "Дара-карака Луна. " в начале
  const patterns = [
    new RegExp(`^${planetName}:\\s*`, 'i'),
    new RegExp(`^Дара-карака\\s+${planetName}\\.?\\s*`, 'i'),
  ];
  let cleaned = text;
  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned;
}

// Сжать многострочный текст в одну строку
function oneLine(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

// Разделить описание на заголовок и тело (как на странице натальной карты)
function splitDescription(text: string): { heading: string; body: string } {
  if (!text) return { heading: "", body: "" };
  const parts = text.split("\n");
  const heading = (parts.shift() ?? "").trim();
  const body = parts.join("\n").trim();
  if (!body) {
    return { heading: "", body: heading };
  }
  return { heading, body };
}

// Попытаться достать Атма/Дара напрямую из chart; если нет — fallback на вычисление (только если не из файла)
function extractKarakasFromChart(chart: ChartPayload, fromFile?: boolean): Karakas {
  const result: Karakas = {};
  if (!isRecord(chart)) return result;
  
  // Помощник: извлечь караки из произвольного контейнера
  const extractFromContainer = (obj: Record<string, unknown>) => {
    // 1) obj.karakas может быть объектом с полями или массивом с ролями
    const kk = (obj as any).karakas;
    if (isRecord(kk)) {
      // напрямую строки или объект с code/planet
      const at = (kk as any).atma ?? (kk as any).atma_karaka ?? (kk as any).atmaKaraka;
      const dk = (kk as any).dara ?? (kk as any).dara_karaka ?? (kk as any).daraKaraka;
      const norm = (val: unknown) => {
        if (typeof val === 'string') return val;
        if (isRecord(val)) {
          const code = (val as any).code ?? (val as any).planet ?? (val as any).id;
          if (typeof code === 'string') return code;
        }
        return undefined;
      };
      const atCode = norm(at);
      const dkCode = norm(dk);
      if (atCode && !result.atma) result.atma = { code: atCode, name: PLANET_NAMES_RU[atCode] ?? atCode };
      if (dkCode && !result.dara) result.dara = { code: dkCode, name: PLANET_NAMES_RU[dkCode] ?? dkCode };
    } else if (Array.isArray(kk)) {
      for (const it of kk) {
        if (!isRecord(it)) continue;
        const role = (it as any).role ?? (it as any).karaka_role;
        const code = (it as any).code ?? (it as any).planet ?? (it as any).id;
        if (typeof code !== 'string') continue;
        if ((role === 'atma' || role === 'Atma') && !result.atma) {
          result.atma = { code, name: PLANET_NAMES_RU[code] ?? code };
        }
        if ((role === 'dara' || role === 'Dara') && !result.dara) {
          result.dara = { code, name: PLANET_NAMES_RU[code] ?? code };
        }
      }
    }
    // 2) корневые поля
    const atRoot = (obj as any).atma ?? (obj as any).atma_karaka ?? (obj as any).atmaKaraka;
    const dkRoot = (obj as any).dara ?? (obj as any).dara_karaka ?? (obj as any).daraKaraka;
    const norm = (val: unknown) => {
      if (typeof val === 'string') return val;
      if (isRecord(val)) {
        const code = (val as any).code ?? (val as any).planet ?? (val as any).id;
        if (typeof code === 'string') return code;
      }
      return undefined;
    };
    const atRootCode = norm(atRoot);
    const dkRootCode = norm(dkRoot);
    if (atRootCode && !result.atma) result.atma = { code: atRootCode, name: PLANET_NAMES_RU[atRootCode] ?? atRootCode };
    if (dkRootCode && !result.dara) result.dara = { code: dkRootCode, name: PLANET_NAMES_RU[dkRootCode] ?? dkRootCode };

    // 3) флаги на планетах внутри этого контейнера
    const planetsLocal = Array.isArray((obj as any).planets) ? ((obj as any).planets as any[]) : [];
    for (const p of planetsLocal) {
      if (!isRecord(p)) continue;
      const code = (p as any).name;
      if (typeof code !== 'string') continue;
      const isAt = Boolean((p as any).is_atma_karaka ?? (p as any).isAtmaKaraka ?? ((p as any).karaka_role === 'atma'));
      const isDk = Boolean((p as any).is_dara_karaka ?? (p as any).isDaraKaraka ?? ((p as any).karaka_role === 'dara'));
      if (isAt && !result.atma) result.atma = { code, name: PLANET_NAMES_RU[code] ?? code };
      if (isDk && !result.dara) result.dara = { code, name: PLANET_NAMES_RU[code] ?? code };
    }
  };

  // Проверяем текущий объект и вложенный chart.chart (как в старом формате)
  extractFromContainer(chart as Record<string, unknown>);
  if ((!result.atma || !result.dara) && isRecord((chart as any).chart)) {
    extractFromContainer(((chart as any).chart) as Record<string, unknown>);
  }
  
  // Fallback: вычислить из готовых процентов/данных, если не нашли в chart (включая загруженные из файла)
  if (!result.atma || !result.dara) {
    const fallback = computeKarakas(chart);
    return { atma: result.atma ?? fallback.atma, dara: result.dara ?? fallback.dara };
  }
  
  return result;
}

type Karakas = { atma?: { code: string; name: string }; dara?: { code: string; name: string } };
function computeKarakas(chart: ChartPayload): Karakas {
  if (!isRecord(chart) || !Array.isArray((chart as any).planets)) return {};
  const allowed = new Set(['Su','Mo','Ma','Me','Ju','Ve','Sa']);
  const ps = ((chart as any).planets as any[])
    .filter((p) => isRecord(p) && typeof (p as any).name === 'string' && allowed.has((p as any).name))
    .map((p) => ({
      code: (p as any).name as string,
      lon: Number((p as any).lon_sidereal ?? 0) || 0,
      percent: Math.max(0, Math.min(100, Math.round(((p as any).house_strength ?? 0) * 100))),
    }));
  if (ps.length === 0) return {};
  let at = ps[0];
  for (const p of ps) {
    if (p.percent > at.percent + 1e-6 || (Math.abs(p.percent - at.percent) <= 1e-6 && p.lon > at.lon)) at = p;
  }
  let dk = ps[0];
  for (const p of ps) {
    if (p.percent < dk.percent - 1e-6 || (Math.abs(p.percent - dk.percent) <= 1e-6 && p.lon < dk.lon)) dk = p;
  }
  return {
    atma: { code: at.code, name: PLANET_NAMES_RU[at.code] ?? at.code },
    dara: { code: dk.code, name: PLANET_NAMES_RU[dk.code] ?? dk.code },
  };
}

// Небольшая полоска-форматтер процента силы, как в таблице созвездий
function StrengthBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const bg = useMemo(() => {
    const p = clamped / 100;
    if (p <= 0.10) return '#e53935';
    if (p < 0.50) {
      const ratio = (p - 0.10) / 0.40;
      const r = Math.round(229 + (251 - 229) * ratio);
      const g = Math.round(57 + (192 - 57) * ratio);
      const b = Math.round(53 + (45 - 53) * ratio);
      return `rgb(${r},${g},${b})`;
    }
    if (p < 0.99) {
      const ratio = (p - 0.50) / 0.49;
      const r = Math.round(251 + (67 - 251) * ratio);
      const g = Math.round(192 + (160 - 192) * ratio);
      const b = Math.round(45 + (71 - 45) * ratio);
      return `rgb(${r},${g},${b})`;
    }
    return '#43a047';
  }, [clamped]);

  return (
    <span className="inline-flex items-center gap-2">
      <span
        title={`Сила: ${clamped}%`}
        style={{ display:'inline-block', width:'72px', height:'12px', borderRadius:'6px', background:'#444', position:'relative', overflow:'hidden', verticalAlign:'middle' }}
      >
        <span style={{ position:'absolute', left:0, top:0, height:'100%', width:`${clamped}%`, background:bg, borderRadius:'6px', transition:'width 0.3s, background 0.3s' }} />
      </span>
      <span>{clamped}%</span>
    </span>
  );
}

function readLocalChartFallback(): { chart: ChartPayload; profile: ProfileSnapshot | null } | null {
  try {
    const raw = localStorage.getItem(SAVED_CHART_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const profile = extractProfileSnapshot(isRecord(parsed) ? parsed.profile : null);
    const chart = isRecord(parsed) ? (parsed.chart as ChartPayload) : null;
    return { profile, chart };
  } catch (error) {
    console.warn("Failed to read local chart fallback", error);
    return null;
  }
}

type ProfilePanelProps = {
  heading: string;
  description?: string;
  state: ProfileState;
  isLoading: boolean;
  onUploadRequest: () => void;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  otherState?: ProfileState; // для направленных расчётов с партнёром
};

function ProfilePanel({ heading, description, state, isLoading, onUploadRequest, onFileChange, inputRef, otherAscSign, otherState }: ProfilePanelProps & { otherAscSign?: string }) {
  const { profile, screenshotUrl, ascSign, chart, loadedFromFile } = state;
  const birthDate = formatBirthDate(profile?.birth);
  const birthAge = calculateAge(profile?.birth);
  const birthTime = formatBirthTime(profile?.birth);
  const city = profile?.cityNameRu || profile?.selectedCity || profile?.cityQuery || "—";
  const dateLine = birthDate ? (birthAge ? `${birthDate} (${birthAge})` : birthDate) : "—";
  const timePlaceLine = [birthTime, city && city !== "—" ? city : null].filter(Boolean).join(", ") || "—";
  const displayName = [profile?.personName, profile?.lastName].filter(Boolean).join(" ") || "Имя Фамилия";

  const kujaDosha = analyzeKujaDosha(chart);
  const veInputs = planetToInputs(chart, "Ve");
  const moInputs = planetToInputs(chart, "Mo");

  // helpers for directional synastry snippets
  const to01 = (x: number) => Math.max(0, Math.min(1, (x + 1) / 2));
  const safeWeight = (w: number) => `${Math.round(w * 100)}%`;

  // distance between planet houses: 1..12 using source house as 1
  const houseDistance = (fromChart: ChartPayload, fromCode: "Mo"|"Su"|"Ma"|"Ve", toChart: ChartPayload, toCode: "Mo"|"Su"|"Ma"|"Ve") => {
    const hA = getPlanetHouse(fromChart as any, fromCode as any);
    const hB = getPlanetHouse(toChart as any, toCode as any);
    if (!hA || !hB) return null;
    const d = (((hB - hA + 12) % 12) + 1) as 1|2|3|4|5|6|7|8|9|10|11|12; // 1..12
    return d;
  };

  const partnerChart = otherState?.chart ?? null;
  const partnerGender = otherState?.profile?.gender;
  const selfGender = profile?.gender;

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 shadow-lg backdrop-blur flex flex-col h-full">
      <div className="flex flex-col gap-4 mb-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-white">{heading}</h2>
          <button
            type="button"
            onClick={onUploadRequest}
            className="rounded-md border border-white/20 bg-slate-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
          >
            открыть файл карты
          </button>
          <input ref={inputRef} type="file" accept="application/json" onChange={onFileChange} className="hidden" />
        </div>
        {description ? <p className="text-sm text-white/60">{description}</p> : null}
      </div>
      <div className="space-y-3 text-sm text-white/80 mb-4">
        {isLoading ? (
          <div className="text-white/60">Загрузка данных...</div>
        ) : profile ? (
          <>
            <div className="text-base text-white" style={{ fontWeight: 700 }}>{displayName}</div>
            <div>
              <span className="text-white/50" style={{ fontWeight: 700 }}>Пол:</span> {profile?.gender === 'male' ? 'мужской' : profile?.gender === 'female' ? 'женский' : '—'}
            </div>
            <div>
              <span className="text-white/50" style={{ fontWeight: 700 }}>Дата рождения:</span> {dateLine}
            </div>
            <div>
              <span className="text-white/50" style={{ fontWeight: 700 }}>Время и место рождения:</span> {timePlaceLine}
            </div>
            <div>
              <span className="text-white/50" style={{ fontWeight: 700 }}>Восходящий знак:</span> {ascSign || "—"}
            </div>
          </>
        ) : (
          <div className="text-white/60">Нет данных.</div>
        )}
      </div>
      <div className="rounded-xl border border-white/10 bg-slate-950/60 p-4">
        {screenshotUrl ? (
          <img src={screenshotUrl} alt="Скриншот карты" className="mx-auto max-h-[260px] w-full max-w-[420px] rounded-lg object-contain" />
        ) : (
          <div className="flex h-[260px] items-center justify-center text-sm text-white/50">
            Скриншот карты пока не найден
          </div>
        )}
      </div>

      {/* Детали профиля после скриншота */}
      {profile && (
        <div className="mt-4 space-y-3 text-sm text-white/70">
          {/* Совместимость по асценденту */}
          {ascSign && otherAscSign && (() => {
            let compatText = getAscCompatibility(ascSign, otherAscSign);
            // Для однополых — удалить секции Любовь/Сексуальная совместимость/Совместная жизнь/Брак
            const g1 = profile?.gender;
            const g2 = otherState?.profile?.gender;
            const oppositeSex = (g1 === 'male' && g2 === 'female') || (g1 === 'female' && g2 === 'male');
            if (compatText && !oppositeSex) {
              const lines = compatText.split('\n');
              const filtered = lines.filter((ln) => !/^\s*(Любовь|Сексуальная совместимость|Совместная жизнь|Брак)\s*:/i.test(ln));
              compatText = filtered.join('\n');
            }
            let compatPercent: number | null = null;
            try {
              const s = getAscCompatScore(ascSign as any, otherAscSign as any);
              compatPercent = Math.round((s || 0) * 100);
            } catch {}
            if (compatText) {
              return (
                <div className="text-white/60">
                  <div className="flex items-baseline justify-between">
                    <div>
                      <span style={{ fontWeight: 700 }}>Совместимость по асценденту:</span>
                    </div>
                    <div className="text-xs text-white/60">вес {Math.round(WEIGHTS.ascendant*100)}%{typeof compatPercent === 'number' ? ` • вклад ${compatPercent}%` : ''}</div>
                  </div>
                  <div className="text-white/80 text-xs mt-1 whitespace-pre-line">{compatText}</div>
                </div>
              );
            }
            return null;
          })()}

          {/* Куджа-доша */}
          <div className="text-white/60">
            {kujaDosha.length > 0 ? (
              <>
                <div className="flex items-baseline justify-between">
                  <div>
                    <span style={{ fontWeight: 700 }}>Куджа-доша:</span> Есть
                    {kujaDosha.map((dosha, idx) => {
                      const extra = ([1,7,8].includes(dosha.house) ? "ядро пары/кризисы/интим" : (dosha.house === 12 ? "постель/утечки энергии" : (dosha.house === 4 ? "быт/мир дома" : (dosha.house === 2 ? "семейная речь/расходы" : null))));
                      return (
                        <span key={idx}>
                          {idx > 0 && ', '}
                          {` — Марс в ${dosha.house} доме (${dosha.sign})${dosha.isRashi ? ' от Луны' : ''}`}
                          {extra ? `, ${dosha.house} — ${extra}.` : ''}
                        </span>
                      );
                    })}
                  </div>
                  {(() => {
                    const selfHas = kujaDosha.length > 0;
                    const partnerHas = otherState?.chart ? analyzeKujaDosha(otherState.chart).length > 0 : false;
                    const p = applyKujaPenaltySimple(100, { hasA: selfHas, hasB: partnerHas });
                    return <div className="text-xs text-red-400 whitespace-nowrap">{p.label}</div>;
                  })()}
                </div>
                <div className="mt-1 text-xs leading-relaxed">
                  Это одно из самых неблагоприятных положений для создания партнёрств. Если слово Куджа-Доша перевести на русский язык, это значит, что у человека взрывной темперамент и его может эмоционально взрывать, может быть ревность. Когда человек с Куджа-дошей ругается, он выпускает эту энергию Марса. Поэтому если Куджа-доша стоит, это не всегда может означать развод. Конечно, когда у человека Куджа-доша очень сложно сохранить отношения, поэтому это может создавать разводы. И конечно же, здесь нужно карму отношений создавать. Куджа-доша особенно сильно проявляются до возраста 28-30 лет, после уже не столько, потому что Марс начинает уже контролироваться.
                </div>
                {/* Смягчители для штрафов (Юпитер/сильные Венера и Луна) учитываются в расчёте, но не выводятся в UI */}
              </>
            ) : (
              <div className="flex items-baseline justify-start">
                <div><span style={{ fontWeight: 700 }}>Куджа-доша:</span> Нет</div>
              </div>
            )}
          </div>

          {/* Анализ женских планет */}
          {profile.gender === 'female' && (
            <div className="text-white/60">
              <div style={{ fontWeight: 700 }}>Анализ женских планет в карте:</div>
              <div className="mt-1 flex items-center justify-between">
                <div>
                  Венера {veInputs ? `${finalStrength(veInputs)}%` : '—'}{' '}
                  {getPlanetMarkerSymbols(getPlanetObject(chart, 'Ve')) ? (
                    <span className="text-white/40">{getPlanetMarkerSymbols(getPlanetObject(chart, 'Ve'))}</span>
                  ) : null}
                </div>
                {veInputs ? <StrengthBar percent={finalStrength(veInputs)} /> : <span>—</span>}
              </div>
              <div className="mt-1 flex items-center justify-between">
                <div>
                  Луна {moInputs ? `${finalStrength(moInputs)}%` : '—'}{' '}
                  {getPlanetMarkerSymbols(getPlanetObject(chart, 'Mo')) ? (
                    <span className="text-white/40">{getPlanetMarkerSymbols(getPlanetObject(chart, 'Mo'))}</span>
                  ) : null}
                </div>
                {moInputs ? <StrengthBar percent={finalStrength(moInputs)} /> : <span>—</span>}
              </div>

              <div className="mt-3 text-white/70 text-xs" style={{ fontWeight: 700 }}>Расшифровка (для женского профиля):</div>
              {veInputs && (
                <div style={{ marginTop: '0.25rem' }}>
                  <div className="text-white/80 text-xs">Венера</div>
                  <ul className="list-disc ml-5 text-xs text-white/70" style={{ marginTop: '0', marginBottom: '0', paddingBottom: '0', lineHeight: '1' }}>
                    {explainInputs(veInputs).map((t, i) => <li key={i} style={{ lineHeight: '1', marginBottom: '0', paddingBottom: '0' }}>{t}</li>)}
                  </ul>
                  <div className="text-xs text-white/70 italic" style={{ marginTop: '0' }}>{thresholdSummary(finalStrength(veInputs))}</div>
                </div>
              )}
              {moInputs && (
                <div style={{ marginTop: '0.25rem' }}>
                  <div className="text-white/80 text-xs">Луна</div>
                  <ul className="list-disc ml-5 text-xs text-white/70" style={{ marginTop: '0', marginBottom: '0', paddingBottom: '0', lineHeight: '1' }}>
                    {explainInputs(moInputs).map((t, i) => <li key={i} style={{ lineHeight: '1', marginBottom: '0', paddingBottom: '0' }}>{t}</li>)}
                  </ul>
                  <div className="text-xs text-white/70 italic" style={{ marginTop: '0' }}>{thresholdSummary(finalStrength(moInputs))}</div>
                </div>
              )}
            </div>
          )}

          {/* Караки */}
          {(() => {
            const k = extractKarakasFromChart(chart, loadedFromFile);
            const karakaDescs = isRecord(chart) && isRecord((chart as any).karaka_descriptions) 
              ? (chart as any).karaka_descriptions as Record<string, unknown>
              : null;
            
            return (k.atma || k.dara) ? (
              <div>
                {k.atma && (() => {
                  const prebuilt = karakaDescs && isRecord(karakaDescs.atma) ? karakaDescs.atma as { heading?: string; body?: string } : null;
                  const parts = prebuilt && (prebuilt.heading || prebuilt.body)
                    ? { heading: prebuilt.heading ?? '', body: prebuilt.body ?? '' }
                    : (() => {
                        const desc = ATMA_KARAKA_DESCRIPTIONS_RU[k.atma!.code] ?? '';
                        return splitDescription(cleanKarakaDescription(desc, k.atma!.name));
                      })();
                  return (
                    <div className="mt-1">
                      <div className="text-sm text-indigo-300" style={{ fontWeight: 700 }}>Атма-карака: {k.atma!.name}</div>
                      {parts.heading ? <div className="mt-1 text-xs text-white/70">{parts.heading}</div> : null}
                      {parts.body ? <div className="mt-1 text-xs text-white/70 whitespace-pre-line">{parts.body}</div> : null}
                    </div>
                  );
                })()}
                {k.dara && (() => {
                  const prebuilt = karakaDescs && isRecord(karakaDescs.dara) ? karakaDescs.dara as { heading?: string; body?: string } : null;
                  const parts = prebuilt && (prebuilt.heading || prebuilt.body)
                    ? { heading: prebuilt.heading ?? '', body: prebuilt.body ?? '' }
                    : (() => {
                        const desc = DARA_KARAKA_DESCRIPTIONS_RU[k.dara!.code] ?? '';
                        return splitDescription(cleanKarakaDescription(desc, k.dara!.name));
                      })();
                  return (
                    <div className="mt-1">
                      <div className="text-sm text-indigo-300" style={{ fontWeight: 700 }}>Дара-карака: {k.dara!.name}</div>
                      {parts.heading ? <div className="mt-1 text-xs text-white/70">{parts.heading}</div> : null}
                      {parts.body ? <div className="mt-1 text-xs text-white/70 whitespace-pre-line">{parts.body}</div> : null}
                    </div>
                  );
                })()}
              </div>
            ) : null;
          })()}

          {/* Луна vs Луна — эмоции/эмпатия (направленно для этого профиля) */}
          {(() => {
            if (!chart || !partnerChart) return null;
            const dSelf = houseDistance(chart, "Mo", partnerChart, "Mo");
            if (!dSelf) return null;
            const raw = affinityBySignDistance(dSelf - 1);
            const percent = Math.round(to01(raw) * 100);
            return (
              <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/60 p-3">
                <div className="flex items-baseline justify-between">
                  <div className="text-white" style={{ fontWeight: 700 }}>Луна vs Луна — эмоции/эмпатия.</div>
                  <div className="text-xs text-white/60">вес {safeWeight(WEIGHTS.moonToMoon)} • вклад {percent}%</div>
                </div>
                <div className="mt-1 text-xs text-white/70">Луна vs Луна: d={dSelf} — {describeMoonMoon(dSelf)}</div>
              </div>
            );
          })()}

          {/* Солнце vs Солнце — эго/воля/роль (направленно для этого профиля) */}
          {(() => {
            if (!chart || !partnerChart) return null;
            const dSelf = houseDistance(chart, "Su", partnerChart, "Su");
            if (!dSelf) return null;
            const raw = affinityBySignDistance(dSelf - 1) * 0.8;
            const percent = Math.round(to01(raw) * 100);
            return (
              <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/60 p-3">
                <div className="flex items-baseline justify-between">
                  <div className="text-white" style={{ fontWeight: 700 }}>Солнце vs Солнце — эго/воля/роль.</div>
                  <div className="text-xs text-white/60">вес {safeWeight(WEIGHTS.sunToSun)} • вклад {percent}%</div>
                </div>
                <div className="mt-1 text-xs text-white/70">Солнце vs Солнце: d={dSelf} — {describeSunSun(dSelf)}</div>
              </div>
            );
          })()}

          {/* Солнце → Луна / Луна → Солнце (направленно и с учётом гендера при наличии) */}
          {(() => {
            if (!partnerChart) return null;
            const selfGender = profile?.gender;
            const partnerGender = otherState?.profile?.gender;
            const oppositeSex = (selfGender === 'male' && partnerGender === 'female') || (selfGender === 'female' && partnerGender === 'male');
            if (!oppositeSex) return null;
            // distances both ways for verdict
            const dStoM = houseDistance(chart, "Su", partnerChart, "Mo");
            const dMtoS = houseDistance(chart, "Mo", partnerChart, "Su");
            if (!dStoM || !dMtoS) return null;
            // choose primary direction for current profile display
            const isMalePrimary = selfGender === 'male' && partnerGender === 'female';
            const isFemalePrimary = selfGender === 'female' && partnerGender === 'male';
            let headerLabel = "Солнце → Луна — как его воля/эго влияют на её эмоции.";
            let pairLabel = "Солнце → Луна";
            let primaryD = dStoM; // contribution and line use primary direction
            if (isFemalePrimary) {
              headerLabel = "Луна → Солнце — как её эмоции/забота питают его волю.";
              pairLabel = "Луна → Солнце";
              primaryD = dMtoS;
            }
            const base = affinityBySignDistance(primaryD - 1);
            const raw = adjustSunMoonRaw(base);
            const percent = Math.round(to01(raw) * 100);
            return (
              <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/60 p-3">
                <div className="flex items-baseline justify-between">
                  <div className="text-white" style={{ fontWeight: 700 }}>{headerLabel}</div>
                  <div className="text-xs text-white/60">вес {safeWeight(WEIGHTS.sunMoonCross)} • вклад {percent}%</div>
                </div>
                <div className="mt-1 text-xs text-white/70">
                  {isFemalePrimary
                    ? (<span>Луна → Солнце: d={dMtoS} — {describeSunMoon("MtoS", dMtoS)}</span>)
                    : (<span>Солнце → Луна: d={dStoM} — {describeSunMoon("StoM", dStoM)}</span>)}
                </div>
              </div>
            );
          })()}

          {/* Секс. совместимость (Марс vs Венера / Венера vs Марс, направленно с учётом гендера) */}
          {(() => {
            if (!partnerChart) return null;
            const selfGender = profile?.gender;
            const partnerGender = otherState?.profile?.gender;
            const oppositeSex = (selfGender === 'male' && partnerGender === 'female') || (selfGender === 'female' && partnerGender === 'male');
            if (!oppositeSex) return null;
            const dVtoM = houseDistance(chart, "Ve", partnerChart, "Ma");
            const dMtoV = houseDistance(chart, "Ma", partnerChart, "Ve");
            if (!dVtoM || !dMtoV) return null;
            let headerLabel = "Венера vs Марс — сексуальная совместимость";
            let pairLabel = "Венера vs Марс";
            let primaryD = dVtoM;
            if (selfGender === 'male' && partnerGender === 'female') {
              headerLabel = "Марс vs Венера — сексуальная совместимость (для мужчины)";
              pairLabel = "Марс vs Венера";
              primaryD = dMtoV;
            } else if (selfGender === 'female' && partnerGender === 'male') {
              headerLabel = "Венера vs Марс — сексуальная совместимость (для женщины)";
              pairLabel = "Венера vs Марс";
              primaryD = dVtoM;
            }
            const raw = affinityBySignDistance(primaryD - 1) * 1.0;
            const percent = Math.round(to01(raw) * 100);
            return (
              <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/60 p-3">
                <div className="flex items-baseline justify-between">
                  <div className="text-white" style={{ fontWeight: 700 }}>{headerLabel}</div>
                  <div className="text-xs text-white/60">вес {safeWeight(WEIGHTS.venusMars)} • вклад {percent}%</div>
                </div>
                <div className="mt-1 text-xs text-white/70">{pairLabel}: d={primaryD}</div>
                <div className="mt-2 text-xs text-white/80">{marsVenusVerdict(dVtoM, dMtoV)}</div>
              </div>
            );
          })()}

          {/* Совместимость по нумерологии (ЧС-число судьбы, ЧД-число души) */}
          {(() => {
            const birthA = profile?.birth;
            const birthB = otherState?.profile?.birth;
            if (!birthA || !birthB) {
              return null;
            }
            try {
              // Определяем порядок: всегда используем порядок профиля 1 (левый) как A, профиля 2 (правый) как B
              const isLeftProfile = heading.includes("Ваша");
              const pair = isLeftProfile 
                ? computePair(birthA, birthB)  // Левый профиль: A=этот профиль, B=партнёр
                : computePair(birthB, birthA); // Правый профиль: A=партнёр, B=этот профиль
              const dir = isLeftProfile ? pair.AtoB : pair.BtoA;
              const partnerName = otherState.profile ? [otherState.profile.personName, otherState.profile.lastName].filter(Boolean).join(" ") : "Партнёр";
              const selfName = [profile.personName, profile.lastName].filter(Boolean).join(" ") || "Вы";
              // Экспрессия по дате (лекция 140)
              const expr = getExpressionCompatByDate(birthA, birthB);
              const exprVklad = Math.round((expr.score / 100) * WEIGHTS.numerology * 100);
              
              return (
                <div className="mt-3 rounded-lg border border-pink-400/30 bg-slate-950/60 p-3">
                  <div className="flex items-baseline justify-between">
                    <div className="text-pink-300" style={{ fontWeight: 700 }}>
                      Совместимость по нумерологии <span style={{ fontWeight: 400 }}>(ЧС-число судьбы, ЧД-число души)</span>
                    </div>
                    <div className="text-right">
                      {(() => {
                        const birthA = profile?.birth;
                        const birthB = otherState?.profile?.birth;
                        let vklad = 0;
                        try {
                          if (birthA && birthB) {
                            const r = scoreNumerology(birthA, birthB);
                            vklad = Math.round(to01(r.raw) * WEIGHTS.numerology * 100);
                          }
                        } catch {}
                        return (
                          <div className="text-xs text-white/50">вес {Math.round(WEIGHTS.numerology*100)}% • вклад {vklad}%</div>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-white/70">
                    <div className="mb-1">
                      <span className="font-semibold text-white/80">{selfName}:</span> ЧД={dir.from.soul}, ЧС={dir.from.dest}
                    </div>
                    <div className="mb-1">
                      <span className="font-semibold text-white/80">{partnerName}:</span> ЧД={dir.to.soul}, ЧС={dir.to.dest}
                    </div>
                    <div className="mt-2 mb-1 text-white/60">
                      <span className="font-semibold">Знаки:</span> <span className="text-pink-300">{dir.arrows.s2s}, {dir.arrows.s2d}, {dir.arrows.d2s}, {dir.arrows.d2d}</span>
                    </div>
                    <div className="text-white/60 text-xs">
                      Сумма баллов: {dir.dirSum > 0 ? '+' : ''}{dir.dirSum} (0 баллов = 50%, диапазон: −8..+8)
                    </div>
                    {/* Экспрессия (по дате рождения) */}
                    <div className="mt-3 border-t border-white/10 pt-2">
                      <div className="flex items-baseline justify-between">
                        <div className="text-pink-200" style={{ fontWeight: 600 }}>Совместимость по нумерологии <span style={{ fontWeight: 400 }}>(экспрессия)</span></div>
                        <div className="text-xs text-white/60">вес {Math.round(WEIGHTS.numerologyExpr*100)}% • вклад {Math.round((expr.score/100)*WEIGHTS.numerologyExpr*100)}%</div>
                      </div>
                      <div className="mt-1 text-xs text-white/70">
                        ЧЭ: {expr.exprA}+{expr.exprB} → <span className="text-pink-300">{expr.tier}</span>
                      </div>
                      <div className="mt-1 text-xs text-white/70 whitespace-pre-line">{expr.text}</div>
                    </div>
                  </div>
                </div>
              );
            } catch (error) {
              console.error("Ошибка расчёта направленной нумерологии:", error);
              return null;
            }
          })()}

          {/* Итог по алгоритму синастрии (персонально для блока): после модулей Венера↔Марс */}
          {(() => {
            if (!partnerChart) return null;
            const directionalSummary = computeDirectionalSynastry({
              selfChart: chart,
              partnerChart,
              selfBirth: profile?.birth,
              partnerBirth: otherState?.profile?.birth,
              selfGender,
              partnerGender,
            });

            const moduleList = directionalSummary.modules;
            const percent = directionalSummary.basePercent;
            const finalPercent = directionalSummary.finalPercent;
            const kujaLabel = directionalSummary.kujaPenalty
              ? `(${directionalSummary.kujaPenalty}%)`
              : '';
            const sunMoonBonus = directionalSummary.sunMoonBonus || 0;
            
            // Формируем формулу расчёта
            const formulaParts: string[] = [];
            formulaParts.push(`${percent}%`);
            if (directionalSummary.kujaPenalty) {
              formulaParts.push(`${directionalSummary.kujaPenalty}% (штраф)`);
            }
            if (sunMoonBonus > 0) {
              formulaParts.push(`+${sunMoonBonus}% (экстра)`);
            }
            const formulaText = formulaParts.join(' ');
            
            return (
              <div className="mt-1 rounded-lg border border-white/10 bg-slate-950/60 p-3">
                <div className="flex items-baseline justify-between">
                  <div className="text-white" style={{ fontWeight: 700 }}>Итог по алгоритму синастрии</div>
                  <div className="text-xl text-indigo-300">
                    <span className="text-sm text-white/60" style={{ fontWeight: 400 }}>{formulaText} = </span>
                    <span style={{ fontWeight: 800 }}>{finalPercent}%</span>
                  </div>
                </div>
                <div className="mt-2 text-xs text-white/70">
                  <div className="mb-1" style={{ fontWeight: 700 }}>Состав итоговой суммы:</div>
                  <ul className="ml-3 list-disc">
                    {moduleList.map((m) => (
                      <li key={m.key} className="mb-1">
                        <span className="font-semibold text-white/80">{m.title} </span>
                        <span className="ml-2 text-white/60">вес {Math.round(m.weight*100)}% • вклад {m.percent}%</span>
                      </li>
                    ))}
                    {directionalSummary.kujaPenalty ? (
                      <li key="kuja-penalty" className="mb-1">
                        <span className="font-semibold text-white/80">Куджа-доша</span>
                        <span className="ml-2 text-red-400">штраф {directionalSummary.kujaPenalty}%</span>
                      </li>
                    ) : null}
                    {sunMoonBonus > 0 ? (
                      <li key="sunmoon-bonus" className="mb-1">
                        <span className="font-semibold text-white/80">Солнце↔Луна в одном доме</span>
                        <span className="ml-2 text-green-400">бонус +{sunMoonBonus}%</span>
                      </li>
                    ) : null}
                  </ul>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </section>
  );
}

type AnalysisPanelProps = {
  leftState: ProfileState;
  rightState: ProfileState;
};

function AnalysisPanel({ leftState, rightState }: AnalysisPanelProps) {
  const leftName = [leftState.profile?.personName, leftState.profile?.lastName].filter(Boolean).join(" ");
  const rightName = [rightState.profile?.personName, rightState.profile?.lastName].filter(Boolean).join(" ");
  const ready = Boolean(leftState.profile && rightState.profile);

  // Pairwise scoring (computed once both profiles exist)
  const pairReport = useMemo(() => {
    if (!leftState.profile || !rightState.profile) return null;
    return scoreSynastry(
      leftState.chart,
      rightState.chart,
      { birth: leftState.profile?.birth, gender: leftState.profile?.gender },
      { birth: rightState.profile?.birth, gender: rightState.profile?.gender },
    );
  }, [leftState.profile, rightState.profile, leftState.chart, rightState.chart]);

  // Kuja status for both partners
  const leftHasKuja = useMemo(() => analyzeKujaDosha(leftState.chart).length > 0, [leftState.chart]);
  const rightHasKuja = useMemo(() => analyzeKujaDosha(rightState.chart).length > 0, [rightState.chart]);

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/70 p-6 shadow-lg backdrop-blur">
      <h2 className="font-semibold text-white mb-2.5" style={{ fontSize: '18px', marginTop: '24px' }}>Слияние карт по домам</h2>
      {/* Убрали вводный абзац и общий итог/топ оверлеев по требованию. Оставляем только слияние карт. */}
      {pairReport && pairReport.overlays.length > 0 && (
        <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
          <MergedOverlayNarrative
            overlays={pairReport.overlays}
            leftName={leftName || '№1'}
            rightName={rightName || '№2'}
            leftProfile={leftState.profile}
            rightProfile={rightState.profile}
          />
        </div>
      )}
      {/* Рекомендация по Куджа-доше: адресно и честно для пары */}
      {(leftHasKuja || rightHasKuja) && (
        <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-900/20 p-4 text-amber-100">
          <div className="text-amber-200 font-semibold mb-2">Рекомендация: влияние Куджа-доши</div>
          {/* Адресовано человеку с Куджей */}
          <div className="text-sm leading-relaxed">
            <div className="mb-2">
              <span className="font-semibold">Персональная карма.</span> Куджа-доша — это показатель личной карты, связанный с вспыльчивостью, ревностью и трудностями с контролем гнева. Это «багаж», который человек приносит в отношения.
            </div>
            {leftHasKuja && (
              <div className="mb-2"><span className="font-semibold">Для {leftName || 'партнёра 1'}:</span> вы видите в итогах конкретный штраф — это ваша зона роста. Фокус — работа с темпераментом и осознанная регуляция энергии Марса. Партнёр без Куджа-доши получает нормальный итог и берёт роль стабилизирующего фактора.</div>
            )}
            {rightHasKuja && (
              <div className="mb-2"><span className="font-semibold">Для {rightName || 'партнёра 2'}:</span> вы видите в итогах конкретный штраф — это ваша зона роста. Фокус — работа с темпераментом и осознанная регуляция энергии Марса. Партнёр без Куджа-доши получает нормальный итог и берёт роль стабилизирующего фактора.</div>
            )}
            <div className="mb-2">
              <span className="font-semibold">Синастрия — про пару.</span> Если у одного есть Куджа, страдают оба: вспышки, конфликты и эмоциональные качели влияют на общий климат в отношениях.
            </div>
            {/* Честная картина для партнёра без Куджа-доши */}
            {!leftHasKuja && rightHasKuja && (
              <div className="mb-2"><span className="font-semibold">Для партнёра без Куджа-доши ({leftName || 'партнёр 1'}):</span> даже если у вас нет Куджа-доши, но у партнёра она есть — жить становится сложнее. Сниженный процент у пары — честная фиксация реальности: «да, у партнёра Куджа, и это ваша общая задача».</div>
            )}
            {leftHasKuja && !rightHasKuja && (
              <div className="mb-2"><span className="font-semibold">Для партнёра без Куджа-доши ({rightName || 'партнёр 2'}):</span> даже если у вас нет Куджа-доши, но у партнёра она есть — жить становится сложнее. Сниженный процент у пары — честная фиксация реальности: «да, у партнёра Куджа, и это ваша общая задача».</div>
            )}
            {/* Мотивация на осознанный выбор — адресовать второму партнёру */}
            <div className="mt-2">
              <span className="font-semibold">Для {rightName || 'партнёра 2'}:</span> видя сниженный итог, оцените масштаб вызова и примите осознанное решение: готовы ли вы с этим работать — выстраивать границы, практиковать стабилизирующие ритуалы и поддерживать конструктивный диалог.
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

type OverlayUINote = {
  from: 'left' | 'right';
  label: string;
  score: number;
  reason: string;
  planet: 'Sun' | 'Moon' | 'Mars' | 'Mercury' | 'Jupiter' | 'Venus' | 'Saturn' | 'Rahu' | 'Ketu';
  targetHouse: 1|2|3|4|5|6|7|8|9|10|11|12;
};

type PersonOverlayForms = {
  nom: string;
  gen: string;
  dat: string;
};

function MergedOverlayNarrative({
  overlays,
  leftName,
  rightName,
  leftProfile,
  rightProfile,
}: {
  overlays: OverlayUINote[];
  leftName: string;
  rightName: string;
  leftProfile: ProfileSnapshot | null;
  rightProfile: ProfileSnapshot | null;
}) {
  const pick = (value?: string | null): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  };

  const stripSurname = (value?: string | null): string | undefined => {
    const text = pick(value);
    if (!text) return undefined;
    const sanitized = text.replace(/[.,;:!?]+$/, "");
    const parts = sanitized.split(/\s+/);
    return parts.length > 0 ? parts[0] : sanitized;
  };

  const adjustCapitalization = (source: string, target: string): string => {
    if (!target) return target;
    const first = target[0];
    if (!first) return target;
    const isUpper = !!source && source[0] === source[0].toUpperCase();
    const newFirst = isUpper ? first.toUpperCase() : first.toLowerCase();
    return newFirst + target.slice(1);
  };

  const deriveNameCases = (nom: string, gender?: ProfileSnapshot["gender"]): { gen: string; dat: string } => {
    const trimmed = nom.trim();
    if (!trimmed) return { gen: trimmed, dat: trimmed };
    const lower = trimmed.toLowerCase();

    const specialCases: Record<string, { gen: string; dat: string }> = {
      "лев": { gen: "льва", dat: "льву" },
      "пётр": { gen: "петра", dat: "петру" },
      "петр": { gen: "петра", dat: "петру" },
      "феликс": { gen: "феликса", dat: "феликсу" },
    };

    const special = specialCases[lower];
    if (special) {
      return {
        gen: adjustCapitalization(trimmed, special.gen),
        dat: adjustCapitalization(trimmed, special.dat),
      };
    }

    const vowels = "аеёиоуыэюя";
    const lastChar = lower[lower.length - 1] ?? "";
    const secondLast = lower.length > 1 ? lower[lower.length - 2] : "";

    if (lower.endsWith("ия")) {
      const stem = trimmed.slice(0, trimmed.length - 2);
      return { gen: stem + "ии", dat: stem + "ии" };
    }

    if (lower.endsWith("ья")) {
      const stem = trimmed.slice(0, trimmed.length - 2);
      return { gen: stem + "ьи", dat: stem + "ье" };
    }

    if (lastChar === "а") {
      const stem = trimmed.slice(0, trimmed.length - 1);
      const softLetters = new Set(["г", "к", "х", "ж", "ч", "ш", "щ", "ь", "й", "ц"]);
      const genSuffix = softLetters.has(secondLast) ? "и" : "ы";
      return { gen: stem + genSuffix, dat: stem + "е" };
    }

    if (lastChar === "я") {
      const stem = trimmed.slice(0, trimmed.length - 1);
      return { gen: stem + "и", dat: stem + "е" };
    }

    if (lower.endsWith("ий")) {
      const stem = trimmed.slice(0, trimmed.length - 2);
      return { gen: stem + "ия", dat: stem + "ию" };
    }

    if (lastChar === "й") {
      const stem = trimmed.slice(0, trimmed.length - 1);
      return { gen: stem + "я", dat: stem + "ю" };
    }

    if (lastChar === "ь") {
      const stem = trimmed.slice(0, trimmed.length - 1);
      if (gender === "female") {
        return { gen: stem + "и", dat: stem + "и" };
      }
      return { gen: stem + "я", dat: stem + "ю" };
    }

    if (["о", "е", "э", "и", "ы", "у", "ю"].includes(lastChar)) {
      return { gen: trimmed, dat: trimmed };
    }

    const consonants = "бвгджзклмнпрстфхцчшщ";
    if (consonants.includes(lastChar)) {
      if (gender === "female") {
        return { gen: trimmed, dat: trimmed };
      }
      return { gen: trimmed + "а", dat: trimmed + "у" };
    }

    return { gen: trimmed, dat: trimmed };
  };

  const composePersonForms = (
    profile: ProfileSnapshot | null,
    fallbackDisplay: string,
    fallbackIndex: 1 | 2,
  ): PersonOverlayForms => {
    const placeholders: Record<1 | 2, PersonOverlayForms> = {
      1: { nom: "партнёр 1", gen: "партнёра 1", dat: "партнёру 1" },
      2: { nom: "партнёр 2", gen: "партнёра 2", dat: "партнёру 2" },
    };

    const displayCandidate = stripSurname(fallbackDisplay);
    const isPlaceholder = !displayCandidate || /^№\d+$/i.test(displayCandidate);
    const fallbackNom = isPlaceholder ? placeholders[fallbackIndex].nom : displayCandidate;
    const fallbackGen = isPlaceholder ? placeholders[fallbackIndex].gen : displayCandidate;
    const fallbackDat = isPlaceholder ? placeholders[fallbackIndex].dat : displayCandidate;
    const manualNom = pick(profile?.nameCases?.nominative) ?? pick(profile?.nameNom);
    const manualGen = pick(profile?.nameCases?.genitive) ?? pick(profile?.nameGen);
    const manualDat = pick(profile?.nameCases?.dative) ?? pick(profile?.nameDat);
    const personName = stripSurname(profile?.personName);

    const baseNom = manualNom ?? personName ?? fallbackNom;
    const usePlaceholderForms = baseNom === placeholders[fallbackIndex].nom;
    const inferred = usePlaceholderForms ? placeholders[fallbackIndex] : deriveNameCases(baseNom, profile?.gender);

    return {
      nom: baseNom,
      gen: manualGen ?? (usePlaceholderForms ? placeholders[fallbackIndex].gen : inferred.gen),
      dat: manualDat ?? (usePlaceholderForms ? placeholders[fallbackIndex].dat : inferred.dat),
    };
  };

  const toOverlayRule = (note: OverlayUINote) => ({
    planet: note.planet,
    targetHouse: note.targetHouse,
    score: note.score,
    label: note.label,
    reason: note.reason,
  });

  const leftForms = composePersonForms(leftProfile, leftName, 1);
  const rightForms = composePersonForms(rightProfile, rightName, 2);

  const toNameForms = (src: PersonOverlayForms, dst: PersonOverlayForms): NameForms => ({
    srcNom: src.nom,
    srcGen: src.gen,
    dstNom: dst.nom,
    dstDat: dst.dat,
  });

  const sortByHouse = (a: ReturnType<typeof toOverlayRule>, b: ReturnType<typeof toOverlayRule>) => a.targetHouse - b.targetHouse;

  const leftRules = overlays
    .filter(n => n.from === 'left')
    .map(toOverlayRule)
    .sort(sortByHouse);
  const rightRules = overlays
    .filter(n => n.from === 'right')
    .map(toOverlayRule)
    .sort(sortByHouse);

  const leftBlock = formatOverlayBlock(
    `1→2: Планеты ${leftForms.gen} в домах ${rightForms.gen}`,
    leftRules,
    toNameForms(leftForms, rightForms),
  );

  const rightBlock = formatOverlayBlock(
    `2→1: Планеты ${rightForms.gen} в домах ${leftForms.gen}`,
    rightRules,
    toNameForms(rightForms, leftForms),
  );

  const renderBlock = (block: { title: string; lines: string[] }) => {
    if (block.lines.length === 0) return null;
    return (
      <div>
        <div className="text-xs text-white/70 mb-1">{block.title}</div>
        <div className="rounded-md border border-white/10 bg-slate-950/40 p-3">
          <ul className="space-y-1 text-xs text-white/80">
            {block.lines.map((line, index) => (
              <li key={`overlay-line-${index}`}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  };

  return (
    <div className="mt-5">
      <div className="mt-2 space-y-4">
        {renderBlock(leftBlock)}
        {renderBlock(rightBlock)}
      </div>
    </div>
  );
}

const initialProfileState: ProfileState = {
  profile: null,
  ascSign: null,
  chart: null,
  screenshotUrl: null,
};

const SinastryPage: React.FC = () => {
  const navigate = useNavigate();
  const [licenseChecked, setLicenseChecked] = useState(false);
  const [licenseAllowed, setLicenseAllowed] = useState(true);
  const [licenseStatus, setLicenseStatus] = useState<ElectronLicenseStatus | null>(null);
  const [primaryState, setPrimaryState] = useState<ProfileState>(initialProfileState);
  const [secondaryState, setSecondaryState] = useState<ProfileState>(initialProfileState);
  const [isLoadingPrimary, setIsLoadingPrimary] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const primaryInputRef = useRef<HTMLInputElement | null>(null);
  const secondaryInputRef = useRef<HTMLInputElement | null>(null);
  const { search } = typeof window !== 'undefined' ? window.location : { search: '' } as Location;
  const params = new URLSearchParams(search);
  const fromFile = params.get('fromFile') === '1';

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const api = (typeof window !== 'undefined') ? window.electronAPI?.license : undefined;
        const status = await api?.getStatus?.();
        if (cancelled) return;
        if (status) setLicenseStatus(status);
        // Fail-open: если статуса нет (web/dev), не блокируем
        const allowed = status == null
          ? true
          : Boolean(status.allowed || status.licensed || (status.trial && typeof status.trial.daysLeft === 'number' && status.trial.daysLeft > 0));
        setLicenseAllowed(allowed);
      } finally {
        if (!cancelled) setLicenseChecked(true);
      }
    }
    check();
    const unsub = (typeof window !== 'undefined') ? window.electronAPI?.license?.onStatus?.((s) => {
      setLicenseStatus(s);
      const allowed = s == null
        ? true
        : Boolean(s.allowed || s.licensed || (s.trial && typeof s.trial.daysLeft === 'number' && s.trial.daysLeft > 0));
      setLicenseAllowed(allowed);
    }) : undefined;
    return () => { cancelled = true; unsub?.(); };
  }, []);

  // Auto-open license prompt when access is not allowed (only on this page)
  const promptShownRef = useRef(false);
  useEffect(() => {
    if (!licenseChecked) return;
    if (licenseAllowed) return;
    if (promptShownRef.current) return;
    promptShownRef.current = true;
    try {
      setTimeout(() => { window.electronAPI?.license?.requestPrompt?.(); }, 150);
    } catch {}
  }, [licenseChecked, licenseAllowed]);

  useEffect(() => {
    // Во время триала/лицензии — грузим данные сразу.
    // Если по какой-то причине статус недоступен (dev) — тоже грузим.
    let isMounted = true;

    async function loadCurrentUser() {
      setErrorMessage(null);
      
      // Мгновенная загрузка из localStorage (как в Questionnaire/UserProfile) — показываем сразу
      const localFallback = readLocalChartFallback();
      if (localFallback?.profile || localFallback?.chart) {
        const initialState = buildProfileState(localFallback.profile ?? null, localFallback.chart ?? null, false);
        if (isMounted) {
          setPrimaryState(initialState);
          // Если есть локальные данные, сразу убираем спиннер загрузки
          setIsLoadingPrimary(false);
        }
      } else {
        // Если нет локальных данных, показываем загрузку
        setIsLoadingPrimary(true);
      }

      // Если пришли с флагом fromFile=1 — не грузим облако, используем только локальные данные
      if (fromFile) {
        if (localFallback?.profile || localFallback?.chart) {
          const state = buildProfileState(localFallback.profile ?? null, localFallback.chart ?? null, true);
          if (isMounted) {
            setPrimaryState(state);
            setIsLoadingPrimary(false);
          }
          // Чистим флаг из URL, чтобы не влиял на дальнейшую навигацию
          try {
            const url = new URL(window.location.href);
            url.searchParams.delete('fromFile');
            window.history.replaceState(null, '', url.toString());
          } catch {/* ignore */}
          return; // Не грузим облако, чтобы не перетёрло локальные данные
        }
      }

      // Если в localStorage уже есть полные данные (имя и дата), не делаем облачный запрос
      const hasCompleteLocalData = (localFallback?.profile?.personName || localFallback?.profile?.lastName) && localFallback?.profile?.birth;
      if (hasCompleteLocalData) {
        return;
      }

      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const userId = sessionData?.session?.user?.id ?? null;
        if (!userId) {
          throw new Error("Пользователь не авторизован.");
        }

        const { data: profileRow, error: profileError } = await supabase
          .from("profiles")
          .select("data")
          .eq("id", userId)
          .single();

        if (profileError) throw profileError;

        // profileRow.data is already the ProfileSnapshot (JSONB column from Supabase)
        // Но нужно нормализовать через extractProfileSnapshot, чтобы избежать лишних полей
        let profile: ProfileSnapshot | null = null;
        if (profileRow?.data && isRecord(profileRow.data)) {
          profile = extractProfileSnapshot(profileRow.data);
        }
        
        let chart: ChartPayload = null;

        try {
          const { data: chartRow, error: chartError } = await supabase
            .from("charts")
            .select("chart")
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (chartError && chartError.code !== "PGRST116") {
            throw chartError;
          }

          if (chartRow && isRecord(chartRow.chart)) {
            chart = chartRow.chart as ChartPayload;
          }
        } catch (chartLoadError) {
          console.warn("Не удалось загрузить карту пользователя", chartLoadError);
        }

        // Если в облачной карте нет скриншота — попробуем найти в хранилище Supabase (как в UserProfilePage)
        if (!chart || !extractChartScreenshot(chart)) {
          try {
            const preferredBuckets = ['charts-screenshots', 'charts', 'public', 'screenshots'];
            for (const bucket of preferredBuckets) {
              try {
                const { data: listData, error: listError } = await supabase.storage.from(bucket).list('', { limit: 100 });
                if (listError || !Array.isArray(listData)) continue;
                const match = listData.find((item: any) => item && typeof item.name === 'string' && item.name.startsWith(`chart-${userId}-`));
                if (match) {
                  const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(match.name);
                  const publicURL = publicData?.publicUrl;
                  if (publicURL) {
                    chart = isRecord(chart) ? { ...(chart as any), screenshotUrl: publicURL } : ({ screenshotUrl: publicURL } as ChartPayload);
                    break;
                  }
                }
              } catch (bucketError) {
                console.warn('Error listing bucket', bucket, bucketError);
              }
            }
          } catch (storageError) {
            console.warn('Error trying to find screenshot in storage buckets', storageError);
          }
        }

        if (!chart || !extractChartScreenshot(chart)) {
          const fallback = readLocalChartFallback();
          if (fallback?.chart && extractChartScreenshot(fallback.chart)) {
            chart = fallback.chart;
          }
          if (!profile && fallback?.profile) {
            profile = fallback.profile;
            if (!chart && fallback.chart) {
              chart = fallback.chart;
            }
          }
        }

        if (isMounted) {
          // Явно устанавливаем loadedFromFile=false, т.к. данные из облака/кэша
          const cloudState = buildProfileState(profile, chart, false);
          
          // Не перетираем локальные данные пустыми/неполными облачными
          setPrimaryState((prev) => {
            // Если у нас уже есть локальные данные с именем, а облачные без имени - оставляем локальные
            const hasLocalData = prev.profile?.personName || prev.profile?.birth;
            const hasCloudData = profile?.personName || profile?.birth;
            
            if (hasLocalData && !hasCloudData) {
              return prev;
            }
            return cloudState;
          });
          setIsLoadingPrimary(false);
        }
      } catch (error) {
        console.warn("Не удалось загрузить данные текущего пользователя", error);
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
          // Не сбрасываем состояние если уже есть локальные данные
          if (!localFallback?.profile && !localFallback?.chart) {
            setPrimaryState(initialProfileState);
          }
          setIsLoadingPrimary(false);
        }
      }
    }

    void loadCurrentUser();

    return () => {
      isMounted = false;
    };
  }, [fromFile]);

  // If we navigated from ChartPage before its screenshot capture finished,
  // re-check localStorage shortly after mount to pick up the fresh screenshot.
  useEffect(() => {
    if (primaryState.screenshotUrl) return;
    const t = setTimeout(() => {
      try {
        const fallback = readLocalChartFallback();
        const shot = fallback?.chart ? extractChartScreenshot(fallback.chart) : null;
        if (shot) {
          setPrimaryState((prev) => {
            if (prev.screenshotUrl) return prev;
            const nextChart = isRecord(prev.chart) ? { ...prev.chart, screenshotUrl: shot } : prev.chart;
            return { ...prev, chart: nextChart, screenshotUrl: shot };
          });
        }
      } catch {/* ignore */}
    }, 700);
    return () => clearTimeout(t);
  }, [primaryState.screenshotUrl]);

  // Обновляем скриншот при изменении localStorage в другом окне/вкладке
  useEffect(() => {
    function handleStorage(ev: StorageEvent) {
      if (ev.key !== SAVED_CHART_KEY) return;
      try {
        const parsed = ev.newValue ? JSON.parse(ev.newValue) : null;
        if (!parsed || typeof parsed !== 'object') return;
        const shot = extractChartScreenshot((parsed as any).chart ?? parsed);
        if (shot) {
          setPrimaryState((prev) => ({ ...prev, screenshotUrl: prev.screenshotUrl || shot }));
        }
      } catch {/* ignore */}
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [licenseChecked, licenseAllowed]);

  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
    setState: React.Dispatch<React.SetStateAction<ProfileState>>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      
      
      
      const profile = extractProfileSnapshot(parsed);
      
      
      let chart: ChartPayload = null;
      if (isRecord(parsed) && isRecord(parsed.chart)) {
        // Unwrap nested payloads like { chart: { chart: { ...actualChart }, meta: ... } }
        const maybeWrapper = parsed.chart as Record<string, unknown>;
        if (isRecord(maybeWrapper.chart)) {
          chart = maybeWrapper.chart as ChartPayload;
        } else {
          chart = maybeWrapper as ChartPayload;
        }
      } else if (isRecord(parsed) && isRecord(parsed.data) && isRecord(parsed.data.chart)) {
        chart = parsed.data.chart as ChartPayload;
      }
      
      
      
      // Главное место где хранится скриншот: parsed.chart.screenshotUrl
      if (isRecord(parsed) && isRecord(parsed.chart)) {
        const chartObj = parsed.chart as Record<string, unknown>;
        if (typeof chartObj.screenshotUrl === 'string') {
          chart = isRecord(chart) ? { ...chart, screenshotUrl: chartObj.screenshotUrl } : ({ screenshotUrl: chartObj.screenshotUrl } as ChartPayload);
        }
      }
      
      // Try parsed.screenshot
      if (!extractChartScreenshot(chart) && isRecord(parsed) && typeof parsed.screenshot === "string") {
        const screenshot = parsed.screenshot;
        if (chart && isRecord(chart)) {
          chart = { ...chart, screenshotUrl: screenshot };
        } else {
          chart = { screenshotUrl: screenshot } as ChartPayload;
        }
      }
      
      // Try top-level meta.screenshotUrl
      if (!extractChartScreenshot(chart) && isRecord(parsed) && isRecord((parsed as any).meta)) {
        const m = (parsed as any).meta as Record<string, unknown>;
        const shot = typeof m.screenshotUrl === 'string' ? m.screenshotUrl : (typeof m.screenshot === 'string' ? m.screenshot : null);
        if (shot) {
          chart = isRecord(chart) ? { ...chart, screenshotUrl: shot } : ({ screenshotUrl: shot } as ChartPayload);
        }
      }
      
      // If screenshot is only available under parsed.chart.chart.screenshotUrl (nested), apply as well
      if (!extractChartScreenshot(chart) && isRecord(parsed) && isRecord(parsed.chart)) {
        const inner = parsed.chart as Record<string, unknown>;
        let innerShot: string | null = null;
        if (isRecord(inner.chart)) {
          const innerChart = inner.chart as Record<string, unknown>;
          innerShot = typeof innerChart.screenshotUrl === 'string' ? innerChart.screenshotUrl
            : (isRecord((innerChart as any).meta) && typeof (innerChart as any).meta.screenshotUrl === 'string' ? (innerChart as any).meta.screenshotUrl
              : (typeof (innerChart as any).screenshot === 'string' ? (innerChart as any).screenshot : null));
        }
        if (innerShot) {
          chart = isRecord(chart) ? { ...chart, screenshotUrl: innerShot } : ({ screenshotUrl: innerShot } as ChartPayload);
        }
      }
      
      const finalScreenshot = extractChartScreenshot(chart);
      
      // Устанавливаем флаг loadedFromFile=true, чтобы не смешивать с кэшем/облаком
      const newState = buildProfileState(profile, chart, true);
      setState(newState);
      setErrorMessage(null);
    } catch (error) {
      console.warn("Не удалось обработать файл карты", error);
      setErrorMessage("Не удалось прочитать файл карты. Проверьте формат JSON.");
    } finally {
      event.target.value = "";
    }
  };

  const licenseGate = (
    <div className="fixed inset-0 z-[1000] bg-white text-black flex items-center justify-center p-6" style={{ display: (!licenseChecked || !licenseAllowed) ? 'flex' : 'none' }}>
      <div className="max-w-md text-center">
        <h2 className="text-xl font-semibold mb-2">Требуется лицензия</h2>
        <p className="text-sm mb-4">Доступ к странице синастрии доступен только при активной лицензии.</p>
        {licenseStatus?.trial?.daysLeft !== undefined && (
          <div className="text-xs text-gray-600 mb-2">Пробная версия: осталось {Math.max(0, licenseStatus.trial.daysLeft)} дн.{licenseStatus.trial.expiresAt ? ` · до ${licenseStatus.trial.expiresAt}` : ''}</div>
        )}
        {licenseStatus?.licenseExpiresAt && (
          <div className="text-xs text-gray-600 mb-2">Срок лицензии: до {licenseStatus.licenseExpiresAt}</div>
        )}
        <div className="flex items-center justify-center gap-2">
          <button className="px-3 py-1.5 rounded border border-gray-300 bg-white hover:bg-gray-50 text-sm" onClick={() => { try { window.electronAPI?.license?.requestPrompt?.(); } catch {} }}>Ввести ключ</button>
          <button className="px-3 py-1.5 rounded border border-gray-300 bg-white hover:bg-gray-50 text-sm" onClick={() => { if (typeof window !== 'undefined') { window.location.href = 'mailto:pilot.vt@mail.ru'; } }}>Написать письмо</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-white px-4 py-8">
      {licenseGate}
      <div className="max-w-6xl mx-auto">
        <header className="mb-6">
          <div className="flex justify-between items-center mb-4">
            <h1 className="text-3xl font-bold">Синастрия</h1>
            <div className="flex flex-wrap gap-2 items-start">
              <button
                onClick={() => navigate("/app")}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
              >
                Новая карта
              </button>
              <button
                onClick={() => navigate("/chart")}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
              >
                Натальная карта
              </button>
              <button
                onClick={() => {
                  // Сохраняем данные primaryState перед переходом на анкету
                  try {
                    if (primaryState.profile || primaryState.chart) {
                      const payloadToSave = {
                        profile: primaryState.profile ?? null,
                        chart: primaryState.chart ?? null,
                        meta: null,
                      };
                      localStorage.setItem(SAVED_CHART_KEY, JSON.stringify(payloadToSave));
                      if (primaryState.profile) {
                        localStorage.setItem(STORAGE_KEY, JSON.stringify({ profile: primaryState.profile }));
                      }
                    }
                  } catch (e) {
                    console.warn('Failed to save data before navigating to questionnaire:', e);
                  }
                  navigate("/questionnaire");
                }}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
              >
                Изменить анкету
              </button>
              <button
                onClick={async () => {
                  const { data: sessionData } = await supabase.auth.getSession();
                  const userId = sessionData?.session?.user?.id;
                  if (userId) navigate(`/user/${userId}`);
                }}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/20 rounded text-sm"
              >
                Профиль
              </button>
              <button
                disabled
                className="px-3 py-1.5 bg-indigo-600 border border-indigo-300 rounded text-sm cursor-default"
              >
                Синастрия
              </button>
            </div>
          </div>
          <p className="text-sm text-white/70">
            Сравнивайте натальные карты двух пользователей. Ваша карта загружается автоматически, вторую можно импортировать из файла.
          </p>
        </header>

        {errorMessage ? (
          <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200 mb-6">
            {errorMessage}
          </div>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', alignItems: 'stretch' }}>
          <ProfilePanel
            heading="Ваша карта"
            state={primaryState}
            isLoading={isLoadingPrimary}
            onUploadRequest={() => primaryInputRef.current?.click()}
            onFileChange={(event) => void handleFileUpload(event, setPrimaryState)}
            inputRef={primaryInputRef}
            otherAscSign={secondaryState.ascSign ?? undefined}
            otherState={secondaryState}
          />
          <ProfilePanel
            heading="Карта для сравнения"
            state={secondaryState}
            isLoading={false}
            onUploadRequest={() => secondaryInputRef.current?.click()}
            onFileChange={(event) => void handleFileUpload(event, setSecondaryState)}
            inputRef={secondaryInputRef}
            otherAscSign={primaryState.ascSign ?? undefined}
            otherState={primaryState}
          />
        </div>

        <div className="mt-6">
          <AnalysisPanel leftState={primaryState} rightState={secondaryState} />
        </div>

        <div style={{ marginTop: '1rem' }} className="text-center text-sm">
          <span style={{ backgroundColor: '#ec4899', color: '#000', padding: '2px 6px', borderRadius: '3px' }}>
            Описание и влияние планет верно настолько, насколько верно времена рождения обоих партнёров!
          </span>
          <br />
          <br />
          <br />
        </div>
      </div>
    </div>
  );
};

export default SinastryPage;
