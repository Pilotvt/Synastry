from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .schemas import ChartRequest, ChartResponse
from .jyotish import compute_chart

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
