export type ThemeMode = "system" | "light" | "dark";

export const getStoredTheme = (): ThemeMode => {
  return (localStorage.getItem("videogen.theme") as ThemeMode) || "system";
};

export const applyTheme = (theme: ThemeMode) => {
  localStorage.setItem("videogen.theme", theme);
  const isDark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
};

export const initThemeListener = () => {
  const current = getStoredTheme();
  applyTheme(current);

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = () => {
    if (getStoredTheme() === "system") {
      applyTheme("system");
    }
  };
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};

