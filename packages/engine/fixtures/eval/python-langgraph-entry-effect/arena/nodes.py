from __future__ import annotations

from .effects import persist_result, search_web


def classify(state: dict[str, object]) -> dict[str, object]:
#   ^^^^^^^^ definition scip-python python sdlc-eval-python-langgraph-entry-effect HEAD `arena.nodes`/classify().
    return {**state, "category": state.get("category")}


def route_after_classify(state: dict[str, object]) -> str:
    return "research" if state.get("category") else "__end__"


def research(state: dict[str, object]) -> dict[str, object]:
    return {**state, "sources": search_web(str(state.get("subject", "")))}


def consolidate(state: dict[str, object]) -> dict[str, object]:
    return {**state, "result": {"sources": state.get("sources", [])}}


def route_after_consolidate(state: dict[str, object]) -> str:
    return "finalize" if state.get("sources") else "__end__"


def finalize(state: dict[str, object]) -> dict[str, object]:
    result = dict(state.get("result", {}))
    persist_result(result)
    return {**state, "result": result}
