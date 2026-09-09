from src.pipeline import run


def test_run_returns_result():
    result = run("ping")
    assert result.prompt == "ping"
    assert result.answer
