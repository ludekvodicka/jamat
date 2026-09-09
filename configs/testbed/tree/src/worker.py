"""Python sample: the highlighter loads its grammar on first use."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Job:
    name: str
    attempts: int = 0

    def retried(self) -> "Job":
        return Job(self.name, self.attempts + 1)


def run(jobs: list[Job], limit: int = 3) -> list[Job]:
    done: list[Job] = []
    for job in jobs:
        while job.attempts < limit:
            job = job.retried()
        done.append(job)
    return done


if __name__ == "__main__":
    for finished in run([Job("index"), Job("scan")]):
        print(f"{finished.name}: {finished.attempts} attempts")
