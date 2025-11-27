from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .schemas import (
    ChartRequest,
    ChartResponse,
    ImageModerationResponse,
    TextModerationRequest,
    TextModerationResponse,
)
from .jyotish import compute_chart
from .moderation.image import analyze_image
from .moderation.text import analyze_text

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/chart", response_model=ChartResponse)
def chart_endpoint(data: ChartRequest):
    return compute_chart(data)


@app.post("/api/moderation/text", response_model=TextModerationResponse)
async def moderation_text(payload: TextModerationRequest) -> TextModerationResponse:
    result = analyze_text(payload.text, payload.language_hint)
    return TextModerationResponse(**result.to_dict())


@app.post("/api/moderation/image", response_model=ImageModerationResponse)
async def moderation_image(file: UploadFile = File(...)) -> ImageModerationResponse:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Пустой файл изображения")

    try:
        result = analyze_image(data, file.filename)
        print(f"[IMAGE MODERATION] {file.filename}: is_clean={result.is_clean}, reason={result.reason}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return ImageModerationResponse(**result.to_dict(), filename=file.filename)
