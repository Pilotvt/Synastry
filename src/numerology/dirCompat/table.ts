export type Sign = "+"|"*"|"0"|"-";

export const NUM_REL: Record<number, { plus: number[]; star: number[]; minus: number[] }> = {
  1: { plus:[2,3,9], star:[5],      minus:[6,8]      }, // Солнце
  2: { plus:[1,3,5], star:[9,8,6],  minus:[]         }, // Луна
  3: { plus:[1,2,9], star:[8],      minus:[5,6]      }, // Юпитер
  4: { plus:[6,8],   star:[5,3],    minus:[1,2,9]    }, // Раху
  5: { plus:[1,6,8], star:[9,3],    minus:[2]        }, // Меркурий
  6: { plus:[5,8],   star:[3,9],    minus:[2,1]      }, // Венера
  7: { plus:[9,2,1], star:[3,5],    minus:[6,8]      }, // Кету
  8: { plus:[5,6],   star:[3],      minus:[9,2,1]    }, // Сатурн
  9: { plus:[1,2,3], star:[6,8],    minus:[5]        }, // Марс
};

export function signOf(fromX: number, toY: number): Sign {
  const row = NUM_REL[fromX];
  if (!row) return "0";
  if (row.plus.includes(toY)) return "+";
  if (row.star.includes(toY)) return "*";
  if (row.minus.includes(toY)) return "-";
  return "0";
}

export function valOf(sign: Sign): number {
  return sign==="+" ? 2 : sign==="*" ? 1 : sign==="-" ? -2 : 0;
}
