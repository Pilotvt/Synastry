import { reduce19 } from "./reduce";

const MONTH_NAMES_RU: Record<string, number> = {
  'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6,
  'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12,
  'январь': 1, 'февраль': 2, 'март': 3, 'апрель': 4, 'май': 5, 'июнь': 6,
  'июль': 7, 'август': 8, 'сентябрь': 9, 'октябрь': 10, 'ноябрь': 11, 'декабрь': 12
};

/** Парс "DD.MM.YYYY" / "D/M/YYYY" / "DD-MM-YYYY" / "19 октября 1984 г." / ISO 8601 */
export function parseDOB(input: string): { day: number; month: number; year: number } {
  // Убираем "г." и лишние пробелы
  const cleaned = input.trim().replace(/\s*г\.?$/i, '').trim();
  
  // Попытка 1: ISO 8601 формат (YYYY-MM-DD или YYYY-MM-DDTHH:mm:ss)
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const year = Number(isoMatch[1]), month = Number(isoMatch[2]), day = Number(isoMatch[3]);
    return { day, month, year };
  }
  
  // Попытка 2: числовой формат DD.MM.YYYY
  const numMatch = cleaned.match(/^(\d{1,2})[.\-/\s](\d{1,2})[.\-/\s](\d{2,4})$/);
  if (numMatch) {
    const day = Number(numMatch[1]), month = Number(numMatch[2]), year = Number(numMatch[3]);
    return { day, month, year: year < 100 ? (year + 1900) : year };
  }
  
  // Попытка 3: текстовый формат "19 октября 1984"
  const textMatch = cleaned.match(/^(\d{1,2})\s+([а-яё]+)\s+(\d{2,4})$/i);
  if (textMatch) {
    const day = Number(textMatch[1]);
    const monthName = textMatch[2].toLowerCase();
    const month = MONTH_NAMES_RU[monthName];
    const year = Number(textMatch[3]);
    if (month) {
      return { day, month, year: year < 100 ? (year + 1900) : year };
    }
  }
  
  throw new Error(`Bad DOB format: ${input}`);
}

/** Число Души (ЧД) = день рождения → свести к 1..9 */
export function soulNumber(dob: string): 1|2|3|4|5|6|7|8|9 {
  const { day } = parseDOB(dob);
  return reduce19(day);
}

/** Число Судьбы (ЧС) = сумма всех цифр ДД+ММ+ГГГГ → свести к 1..9 */
export function destinyNumber(dob: string): 1|2|3|4|5|6|7|8|9 {
  const { day, month, year } = parseDOB(dob);
  const sum = [...`${day}${month}${year}`].reduce((s,d)=>s+Number(d),0);
  return reduce19(sum);
}

/** ВРЕМЕННАЯ совместимость: alias для старого кода (если где-то осталось) */
export const charNumber = soulNumber;
