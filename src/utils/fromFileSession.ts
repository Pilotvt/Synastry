const SESSION_KEY = 'synastry_chart_from_file_session';

export function isChartSessionFromFile(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function setChartSessionFromFile(active: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (active) {
      window.sessionStorage.setItem(SESSION_KEY, '1');
    } else {
      window.sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // ignore sessionStorage errors (private mode, etc.)
  }
}
