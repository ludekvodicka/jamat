"""Entry point for {{name}}."""
from .pipeline import run


def main() -> None:
    result = run(prompt="Hello from {{name}}")
    print(result)


if __name__ == "__main__":
    main()
