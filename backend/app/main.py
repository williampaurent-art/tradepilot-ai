
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
    idea = strategy.description

    draft = build_strategy(idea)

    draft["name"] = strategy.name
    draft["symbol"] = strategy.symbol.upper()
    draft["timeframe"] = strategy.timeframe.upper()
    draft["original_idea"] = idea

    return {
        "status": "draft_created",
        "strategy": draft,
        "backtest_status": "not_started",
        "live_trading": False
    }



from typing import Literal

from pydantic import BaseModel, Field


class StrategyRequest(BaseModel):
    idea: str = Field(min_length=5, max_length=1000)


def build_strategy(idea: str) -> dict:
    """Génère un brouillon structuré, sans envoyer d'ordres."""
    text = idea.lower()

    if "moyenne mobile" in text or "croisement" in text:
        return {
            "name": "Croisement de moyennes mobiles",
            "symbol": "EURUSD",
            "timeframe": "M15",
            "type": "trend_following",
            "entry_rules": {
                "buy": "La moyenne mobile rapide croise au-dessus de la lente.",
                "sell": "La moyenne mobile rapide croise au-dessous de la lente."
            },
            "exit_rules": {
                "buy": "Sortie lorsque le signal inverse apparaît ou qu'une limite de risque est atteinte.",
                "sell": "Sortie lorsque le signal inverse apparaît ou qu'une limite de risque est atteinte."
            },
            "parameters": {
                "fast_ma_period": 20,
                "slow_ma_period": 50,
                "ma_type": "EMA",
                "stop_loss_pips": 20,
                "take_profit_pips": 40
            },
            "risk_management": {
                "risk_per_trade_percent": 1,
                "max_open_positions": 1
            },
            "original_idea": idea,
            "status": "draft",
            "trading_enabled": False,
            "backtest_completed": False
        }

    return {
        "name": "Brouillon de stratégie",
        "original_idea": idea,
        "status": "needs_configuration",
        "message": "Cette idée nécessite des règles d'entrée et de sortie plus précises.",
        "trading_enabled": False,
        "backtest_completed": False
    }
