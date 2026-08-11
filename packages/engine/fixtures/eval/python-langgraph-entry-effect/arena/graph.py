from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from .nodes import (
    classify,
    consolidate,
    finalize,
    research,
    route_after_classify,
    route_after_consolidate,
)


def build() -> StateGraph:
#   ^^^^^ definition scip-python python sdlc-eval-python-langgraph-entry-effect HEAD `arena.graph`/build().
    builder = StateGraph(dict)
    builder.add_node("classify", classify)
    builder.add_node("research", research)
    builder.add_node("consolidate", consolidate)
    builder.add_node("finalize", finalize)
    builder.add_edge(START, "classify")
    builder.add_conditional_edges("classify", route_after_classify, ["research", END])
    builder.add_edge("research", "consolidate")
    builder.add_conditional_edges(
        "consolidate", route_after_consolidate, ["finalize", END]
    )
    builder.add_edge("finalize", END)
    return builder


graph = build().compile()
