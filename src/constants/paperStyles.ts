export const PAPER_SURFACE_STYLE: Record<string, string> = {
  backgroundColor: "rgba(255, 255, 255, 0.92)",
  backgroundImage: "var(--paper-texture-image)",
  backgroundSize: "var(--paper-texture-size)",
  backgroundRepeat: "repeat",
  border: "1px solid rgba(120, 80, 40, 0.35)",
  color: "#2b1c0f",
};

export const PAPER_INPUT_STYLE: Record<string, string> = {
  ...PAPER_SURFACE_STYLE,
  boxShadow: "inset 0 1px 1px rgba(0, 0, 0, 0.05)",
};

