export type ResidenceCarrier = {
  residenceCountry?: string | null;
  residenceCityName?: string | null;
};

export function stripResidenceFields<T extends ResidenceCarrier | null | undefined>(snapshot: T): T | null {
  if (!snapshot) return null;
  const clone = { ...(snapshot as Record<string, unknown>) } as ResidenceCarrier & Record<string, unknown>;
  delete clone.residenceCountry;
  delete clone.residenceCityName;
  return clone as T;
}
