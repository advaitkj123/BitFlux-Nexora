"""
Smoke test: runs the full hackathon pipeline on real resume PDFs.
Run from the backend directory:
    python scripts/smoke_test_pipeline.py
"""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

RESUME_DIR = Path("F:/Nexora/Resumes/Telegram_scrape")

SAMPLE_JD = """
Job Title: Junior Full Stack Developer Intern
Company: TechNova Solutions

About the Role:
We are looking for a motivated Junior Full Stack Developer Intern to join our engineering team.
You will work on building modern web applications using our tech stack.

Requirements:
- Strong knowledge of JavaScript and TypeScript
- Experience with React or similar frontend framework
- Backend development with Node.js and Express
- Database experience with MongoDB or PostgreSQL
- Familiarity with REST API design
- Basic knowledge of Git and version control
- Understanding of HTML and CSS

Nice to Have:
- Experience with Docker or containerization
- Familiarity with cloud platforms (AWS, Azure, or Google Cloud)
- Knowledge of GraphQL
- CI/CD pipeline experience
- Unit testing experience (Jest, Mocha)
- React Native experience

What You Will Do:
- Build and maintain responsive web applications
- Write clean, maintainable code
- Collaborate with senior developers
- Participate in code reviews
- Work in an Agile environment
"""


async def main():
    from app.services.hackathon_pipeline import run_pipeline

    print()
    print("=" * 70)
    print("HACKATHON PIPELINE SMOKE TEST")
    print("=" * 70)

    pdf_files = list(RESUME_DIR.glob("*.pdf"))[:18]
    if not pdf_files:
        print(f"[FAIL] No PDFs found in {RESUME_DIR}")
        return

    print(f"[*] Found {len(pdf_files)} resume PDFs")
    print(f"[*] JD: Junior Full Stack Developer Intern ({len(SAMPLE_JD)} chars)")
    print()

    resume_data = []
    for path in pdf_files:
        try:
            content = path.read_bytes()
            resume_data.append((path.name, content))
        except Exception as e:
            print(f"  [WARN] Could not read {path.name}: {e}")

    print(f"[*] Loaded {len(resume_data)} resumes")
    print("[*] Running pipeline...")
    print()

    t0 = time.monotonic()
    try:
        result = await run_pipeline(
            jd_text=SAMPLE_JD,
            resume_file_data=resume_data,
        )
    except Exception as e:
        print(f"[FAIL] Pipeline failed: {e}")
        import traceback
        traceback.print_exc()
        return

    total_ms = int((time.monotonic() - t0) * 1000)

    print("=" * 70)
    print(f"[OK] PIPELINE COMPLETE in {total_ms}ms")
    print("=" * 70)

    print(f"\n[*] JD Analysis:")
    print(f"  Required skills ({len(result.parsed_jd.required_skills)}): "
          f"{', '.join(result.parsed_jd.required_skills[:8])}")
    print(f"  Preferred skills ({len(result.parsed_jd.preferred_skills)}): "
          f"{', '.join(result.parsed_jd.preferred_skills[:5])}")

    print(f"\n[*] RANKED CANDIDATES:")
    print(f"{'Rank':<5} {'Name':<30} {'Final':>7} {'KW':>7} {'SEM':>7} {'Penalty':>8}  Missing")
    print("-" * 90)
    for c in result.ranked_candidates:
        missing_str = ", ".join(c.missing_required[:3])
        if len(c.missing_required) > 3:
            missing_str += "..."
        print(
            f"#{c.rank:<4} {c.candidate_name[:28]:<30} {c.final_score:>7.1f} "
            f"{c.keyword_score:>7.1f} {c.semantic_score:>7.1f} "
            f"{-c.penalty_applied:>8.1f}  {missing_str}"
        )

    scores = [c.final_score for c in result.ranked_candidates]
    print(f"\n[*] Score Spread:")
    print(f"  Top:    {scores[0]:.1f}")
    print(f"  Median: {sorted(scores)[len(scores)//2]:.1f}")
    print(f"  Bottom: {scores[-1]:.1f}")
    print(f"  Spread: {scores[0] - scores[-1]:.1f} points")

    if scores[0] - scores[-1] < 15:
        print("  [WARN] Low spread! Consider increasing penalty_per_missing.")
    else:
        print("  [OK] Good spread -- ranking looks meaningful!")

    print(f"\n[*] TOP 3 EXPLANATIONS:")
    for exp in result.explanations:
        print(f"\n  Rank #{exp.rank} -- {exp.candidate_name}")
        print(f"  Score: {exp.final_score:.1f} | KW: {exp.keyword_score:.1f} | SEM: {exp.semantic_score:.1f}")
        print(f"  Matched: {', '.join(exp.matched_skills[:5]) or 'None'}")
        print(f"  Missing: {', '.join(exp.missing_required_skills[:4]) or 'None'}")
        print(f"  Summary: {exp.template_summary[:250]}...")

    print(f"\n[*] BIAS FLAGS ({len(result.bias_flags)}):")
    for flag in result.bias_flags[:3]:
        print(f"  [{flag.severity.upper()}] '{flag.phrase}' -- {flag.reason[:80]}")

    print(f"\n[*] Latency breakdown:")
    for k, v in result.latency_breakdown.items():
        print(f"  {k}: {v}ms")

    print()
    print("=" * 70)
    print("[OK] Smoke test complete. System is ready for the hackathon demo.")
    print("=" * 70)
    print()


if __name__ == "__main__":
    asyncio.run(main())
