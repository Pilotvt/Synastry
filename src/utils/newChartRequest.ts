export const NEW_CHART_REQUEST_EVENT = 'synastry:new-chart-request';
export const NEW_CHART_CONFIRMED_EVENT = 'synastry:new-chart-confirmed';

export type NewChartRequestOrigin = 'button' | 'menu' | 'shortcut' | string;

export function requestNewChartReset(origin: NewChartRequestOrigin = 'button') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NEW_CHART_REQUEST_EVENT, { detail: { origin } }));
}

export function emitNewChartConfirmed(origin: NewChartRequestOrigin = 'button') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NEW_CHART_CONFIRMED_EVENT, { detail: { origin } }));
}
