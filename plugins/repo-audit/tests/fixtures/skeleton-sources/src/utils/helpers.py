"""Utility helpers for the application."""

from typing import List, Optional
import os
from pathlib import Path


def parse_config(path: str) -> dict:
    """Parse a config file."""
    return {}


async def fetch_data(url: str, timeout: int = 30) -> Optional[dict]:
    """Fetch data from URL."""
    return None


class ConfigParser:
    """Config file parser."""

    def __init__(self, path: str):
        self.path = path

    def read(self) -> dict:
        return {}

    def write(self, data: dict) -> None:
        pass


class ValidationError(Exception):
    """Raised on validation failure."""
    pass
