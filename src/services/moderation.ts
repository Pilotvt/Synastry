const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://127.0.0.1:8000";
const TEXT_ENDPOINT = `${API_BASE_URL.replace(/\/$/, "")}/api/moderation/text`;
const IMAGE_ENDPOINT = `${API_BASE_URL.replace(/\/$/, "")}/api/moderation/image`;

export type TextModerationVerdict = {
  isClean: boolean;
  matches: string[];
  censoredText: string;
  reasons: string[];
  modelLabel?: string | null;
  modelConfidence?: number | null;
};

export type ImageModerationVerdict = {
  isClean: boolean;
  reason: string;
  detections: Array<{
    class: string;
    score: number;
    box: number[];
  }>;
  filename?: string | null;
};

type RawVerdict = {
  is_clean: boolean;
  matches: string[];
  censored_text: string;
  reasons: string[];
  model_label?: string | null;
  model_confidence?: number | null;
};

export async function moderateText(text: string, languageHint = "ru"): Promise<TextModerationVerdict | null> {
  const payload = {
    text,
    language_hint: languageHint,
  };
  try {
    const response = await fetch(TEXT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `moderation request failed (${response.status})`);
    }
    const data: RawVerdict = await response.json();
    return {
      isClean: data.is_clean,
      matches: data.matches ?? [],
      censoredText: data.censored_text ?? text,
      reasons: data.reasons ?? [],
      modelLabel: data.model_label ?? null,
      modelConfidence: data.model_confidence ?? null,
    };
  } catch (error) {
    console.warn("Не удалось проверить текст модерацией", error);
    return null;
  }
}

export async function moderateImage(file: File): Promise<ImageModerationVerdict | null> {
  console.log("[MODERATION] Checking image:", file.name, file.size);
  try {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(IMAGE_ENDPOINT, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[MODERATION] Request failed:", response.status, detail);
      throw new Error(detail || `image moderation failed (${response.status})`);
    }

    const data = await response.json();
    console.log("[MODERATION] Result:", data);
    return {
      isClean: data.is_clean ?? true,
      reason: data.reason ?? "",
      detections: data.detections ?? [],
      filename: data.filename ?? null,
    };
  } catch (error) {
    console.error("[MODERATION] Error:", error);
    return null;
  }
}
