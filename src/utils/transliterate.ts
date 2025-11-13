const RU_TO_LAT_MAP: Record<string, string> = {
  "\u0430": "a",
  "\u0431": "b",
  "\u0432": "v",
  "\u0433": "g",
  "\u0434": "d",
  "\u0435": "e",
  "\u0451": "yo",
  "\u0436": "zh",
  "\u0437": "z",
  "\u0438": "i",
  "\u0439": "y",
  "\u043a": "k",
  "\u043b": "l",
  "\u043c": "m",
  "\u043d": "n",
  "\u043e": "o",
  "\u043f": "p",
  "\u0440": "r",
  "\u0441": "s",
  "\u0442": "t",
  "\u0443": "u",
  "\u0444": "f",
  "\u0445": "h",
  "\u0446": "ts",
  "\u0447": "ch",
  "\u0448": "sh",
  "\u0449": "sch",
  "\u044a": "",
  "\u044b": "y",
  "\u044c": "",
  "\u044d": "e",
  "\u044e": "yu",
  "\u044f": "ya",
};

const DIACRITIC_REGEX = /[\u0300-\u036f]/g;
const RAW_APOSTROPHE_REGEX = /[`´’ʼʻ]/g;
const DISPLAY_APOSTROPHE_REGEX = /['`´’ʼʻ]/g;
const APOSTROPHE_CHARS = new Set(["'"]);

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(DIACRITIC_REGEX, "");
}

function normalizeLatinInput(word: string): string {
  if (!word) return "";
  let value = word;
  value = value.replace(RAW_APOSTROPHE_REGEX, "'");
  value = value.replace(/Ë/g, "Yo").replace(/ë/g, "yo");
  value = stripDiacritics(value);
  return value;
}

export function hasCyrillic(text: string): boolean {
  return /[\u0400-\u04FF]/.test(text);
}

export function norm(text: string): string {
  return stripDiacritics((text || "").toLowerCase());
}

export function ruToLat(text: string): string {
  return (text || "")
    .toLowerCase()
    .split("")
    .map((ch) => RU_TO_LAT_MAP[ch] ?? ch)
    .join("");
}

export function latinWordToRu(word: string): string {
  if (!word) return word;
  const normalizedWord = normalizeLatinInput(word);
  const lower = normalizedWord.toLowerCase();
  let result = "";
  let i = 0;

  const take = (substr: string, replacement: string) => {
    result += replacement;
    i += substr.length;
  };

  while (i < lower.length) {
    const slice = lower.slice(i);
    if (slice.startsWith("moskva")) {
      take("moskva", "москва");
      continue;
    }
    if (slice.startsWith("moscow")) {
      take("moscow", "москва");
      continue;
    }
    if (slice.startsWith("saint")) {
      take("saint", "санкт");
      continue;
    }
    if (slice.startsWith("sankt")) {
      take("sankt", "санкт");
      continue;
    }
    if (slice.startsWith("petersburg")) {
      take("petersburg", "петербург");
      continue;
    }
    if (slice.startsWith("nizhny")) {
      take("nizhny", "нижний");
      continue;
    }
    if (slice.startsWith("novyy")) {
      take("novyy", "новый");
      continue;
    }
    if (slice.startsWith("novy")) {
      take("novy", "новый");
      continue;
    }
    if (slice.startsWith("yekaterinburg")) {
      take("yekaterinburg", "екатеринбург");
      continue;
    }
    if (slice.startsWith("ekaterinburg")) {
      take("ekaterinburg", "екатеринбург");
      continue;
    }
    if (slice.startsWith("ufa")) {
      take("ufa", "уфа");
      continue;
    }
    if (slice.startsWith("new")) {
      take("new", "нью");
      continue;
    }
    if (slice.startsWith("shch")) {
      take("shch", "щ");
      continue;
    }
    if (slice.startsWith("sch")) {
      take("sch", "щ");
      continue;
    }
    if (slice.startsWith("tch")) {
      take("tch", "ч");
      continue;
    }
    if (slice.startsWith("ch")) {
      take("ch", "ч");
      continue;
    }
    if (slice.startsWith("sh")) {
      take("sh", "ш");
      continue;
    }
    if (slice.startsWith("zh")) {
      take("zh", "ж");
      continue;
    }
    if (slice.startsWith("kh")) {
      take("kh", "х");
      continue;
    }
    if (slice.startsWith("ts")) {
      take("ts", "ц");
      continue;
    }
    if (slice.startsWith("yo")) {
      take("yo", "ё");
      continue;
    }
    if (slice.startsWith("yu")) {
      take("yu", "ю");
      continue;
    }
    if (slice.startsWith("ya")) {
      take("ya", "я");
      continue;
    }
    if (slice.startsWith("ye")) {
      take("ye", "е");
      continue;
    }
    if (slice.startsWith("yi")) {
      take("yi", "и");
      continue;
    }
    if (slice.startsWith("qu")) {
      take("qu", "кв");
      continue;
    }
    if (slice.startsWith("ph")) {
      take("ph", "ф");
      continue;
    }
    if (slice.startsWith("th")) {
      take("th", "т");
      continue;
    }
    if (slice.startsWith("ck")) {
      take("ck", "к");
      continue;
    }
    if (slice.startsWith("st")) {
      take("st", "ст");
      continue;
    }

    const current = lower[i];
    if (APOSTROPHE_CHARS.has(current)) {
      result += "ь";
      i += 1;
      continue;
    }

    switch (current) {
      case "a":
        result += "а";
        break;
      case "b":
        result += "б";
        break;
      case "c":
        result += "ц";
        break;
      case "d":
        result += "д";
        break;
      case "e":
        result += "е";
        break;
      case "f":
        result += "ф";
        break;
      case "g":
        result += "г";
        break;
      case "h":
        result += "х";
        break;
      case "i":
        result += "и";
        break;
      case "j":
        result += "дж";
        break;
      case "k":
        result += "к";
        break;
      case "l":
        result += "л";
        break;
      case "m":
        result += "м";
        break;
      case "n":
        result += "н";
        break;
      case "o":
        result += "о";
        break;
      case "p":
        result += "п";
        break;
      case "q":
        result += "к";
        break;
      case "r":
        result += "р";
        break;
      case "s":
        result += "с";
        break;
      case "t":
        result += "т";
        break;
      case "u":
        result += "у";
        break;
      case "v":
        result += "в";
        break;
      case "w":
        result += "в";
        break;
      case "x":
        result += "кс";
        break;
      case "y":
        result += i === 0 ? "й" : "ы";
        break;
      case "z":
        result += "з";
        break;
      default:
        result += current;
        break;
    }
    i += 1;
  }

  if (lower.endsWith("iy")) {
    result = result.replace(/ии$/u, "ий");
  } else if (lower.endsWith("yy")) {
    result = result.replace(/ии$/u, "ый");
  }
  if (lower.endsWith("sky")) {
    result = result.replace(/ски$/u, "ский");
  }
  if (lower.endsWith("skiy")) {
    result = result.replace(/ский$/u, "ский");
  }
  if (lower.endsWith("skaya")) {
    result = result.replace(/ская$/u, "ская");
  }
  if (lower.endsWith("skoye")) {
    result = result.replace(/ское$/u, "ское");
  }
  if (lower.endsWith("ny")) {
    result = result.replace(/ни$/u, "ний");
  }
  if (lower.endsWith("oy")) {
    result = result.replace(/ои$/u, "ой");
  }

  return result;
}

export function latinToRuName(name: string): string {
  if (!name || hasCyrillic(name)) return name;
  return name
    .split(/([\s\-]+)/)
    .map((segment) => {
      if (!/[A-Za-z]/.test(segment)) {
        return segment.replace(DISPLAY_APOSTROPHE_REGEX, "ь");
      }
      const match = segment.match(/^([A-Za-z]+)(.*)$/);
      if (!match) return segment;
      const [, word, suffix] = match;
      const transliterated = latinWordToRu(word);
      const formatted =
        word === word.toUpperCase()
          ? transliterated.toUpperCase()
          : transliterated
          ? transliterated[0].toUpperCase() + transliterated.slice(1)
          : transliterated;
      return formatted + suffix.replace(DISPLAY_APOSTROPHE_REGEX, "ь");
    })
    .join("");
}

export function latinToRuApprox(text: string): string {
  let value = (text || "").toLowerCase();
  value = value.replace(/[^a-z0-9]+/g, " ");
  value = value.replace(/qu/g, "kv");
  value = value.replace(/ck/g, "k");
  value = value.replace(/sc/g, "sk");
  value = value.replace(/ph/g, "f");
  value = value.replace(/th/g, "t");
  value = value.replace(/w/g, "v");
  value = value.replace(/x/g, "ks");
  value = value.replace(/ov\b/g, "va");
  value = value.replace(/ev\b/g, "yeva");
  value = value.replace(/sky\b/g, "skiy");
  value = value.replace(/iy\b/g, "iy");
  value = value.replace(/\s+/g, "");
  return value;
}
