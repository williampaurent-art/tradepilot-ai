
from datetime import datetime, timezone

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(
    title="TradePilot AI API",
    version="0.1.0",
    description="API de base de TradePilot AI"
)


class StrategyDraft(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=2000)
    symbol: str = Field(min_length=1, max_length=30)
    timeframe: str = Field(default="M15", max_length=10)


@app.get("/")
def home():
    return {
        "name": "TradePilot AI",
        "status": "running",
        "mode": "development"
    }


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "trading_enabled": False
    }


@app.post("/api/strategies/drafts")
def create_strategy_draft(strategy: StrategyDraft):
    return {
        "status": "draft_created",
        "strategy": strategy.model_dump(),
        "backtest_status": "not_started",
        "live_trading": False
    }

