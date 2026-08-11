from __future__ import annotations


def search_web(query: str) -> list[str]:
#   ^^^^^^^^^^ definition scip-python python sdlc-eval-python-langgraph-entry-effect HEAD `arena.effects`/search_web().
    return [query] if query else []


def persist_result(result: dict[str, object]) -> None:
    _ = result
