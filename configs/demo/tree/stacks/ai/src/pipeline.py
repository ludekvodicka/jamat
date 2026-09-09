"""{{description}}"""
from dataclasses import dataclass


@dataclass
class Result:
    prompt: str
    answer: str


def run(prompt: str) -> Result:
    # Placeholder pipeline. The real project wires this to the Anthropic SDK.
    return Result(prompt=prompt, answer="(sample response)")
