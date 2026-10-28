/**
 * localStorage that never throws. Browsers with site data blocked, some private
 * modes and full quotas all make the real thing raise; for preferences like the
 * theme that is no reason to take the page down.
 */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // storage unavailable: the preference simply is not remembered
    }
  }
};
