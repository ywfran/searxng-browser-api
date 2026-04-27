#!/usr/bin/env python3
"""
Search API Test Suite for SearXNG Headless

Clean, professional test script that correctly identifies success
based on number of results returned.
"""

import json
import subprocess
import sys
from dataclasses import dataclass
from typing import Dict, Any, List


@dataclass
class SearchResult:
    """Represents the outcome of a single search request."""
    query: str
    instance_used: str
    elapsed_ms: int
    error_count: int
    num_results: int
    success: bool


class SearchAPITester:
    """Professional tester for the local SearXNG headless search API."""

    def __init__(self, base_url: str = "http://localhost:3030"):
        self.base_url = base_url

    def search(self, query: str, categories: str = "general", max_results: int = 3) -> SearchResult:
        """
        Execute search request and parse response.
        """
        payload = {
            "query": query,
            "categories": categories,
            "maxResults": max_results
        }

        cmd = [
            "curl", "-s", "-X", "POST",
            f"{self.base_url}/search",
            "-H", "Content-Type: application/json",
            "-d", json.dumps(payload)
        ]

        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
                timeout=15
            )

            data: Dict[str, Any] = json.loads(proc.stdout)

            num_results = len(data.get("results", []))
            error_count = len(data.get("errors", []))

            # Success = returned at least one result (even with some internal errors)
            success = num_results > 0

            return SearchResult(
                query=query,
                instance_used=data.get("instanceUsed", "UNKNOWN"),
                elapsed_ms=data.get("elapsedMs", 0),
                error_count=error_count,
                num_results=num_results,
                success=success
            )

        except subprocess.TimeoutExpired:
            print(f"ERROR: Timeout for query: {query}", file=sys.stderr)
        except json.JSONDecodeError:
            print(f"ERROR: Invalid JSON response for query: {query}", file=sys.stderr)
        except Exception as e:
            print(f"ERROR: Failed to search '{query}': {e}", file=sys.stderr)

        # Return failure object in case of exception
        return SearchResult(
            query=query,
            instance_used="N/A",
            elapsed_ms=0,
            error_count=1,
            num_results=0,
            success=False
        )

    def run_tests(self, test_cases: List[Dict[str, Any]]) -> None:
        """Run tests and display clear results."""
        print("Search API Test - SearXNG Headless")
        print("=" * 75)

        total_time_success = 0
        successful_tests = 0

        for i, case in enumerate(test_cases, 1):
            query = case["query"]
            categories = case.get("categories", "general")
            max_results = case.get("maxResults", 3)

            print(f"\nTest {i}/{len(test_cases)} | Query: {query}")

            result = self.search(query, categories, max_results)

            status_str = "SUCCESS" if result.success else "FAILED "

            print(f"  Status       : {status_str}")
            print(f"  Instance     : {result.instance_used}")
            print(f"  Time         : {result.elapsed_ms} ms")
            print(f"  Results      : {result.num_results}")
            print(f"  Errors       : {result.error_count}")

            if result.success:
                successful_tests += 1
                total_time_success += result.elapsed_ms

        print("\n" + "=" * 75)
        print("Summary")
        print(f"  Total tests          : {len(test_cases)}")
        print(f"  Successful           : {successful_tests}")
        print(f"  Success rate         : {successful_tests / len(test_cases):.0%}")
        if successful_tests > 0:
            print(f"  Total time (success) : {total_time_success} ms")


def main():
    tester = SearchAPITester(base_url="http://localhost:3030")

    test_cases = [
        {
            "query": "climate change solutions",
            "categories": "general",
            "maxResults": 3
        },
        {
            "query": "quantum computing basics",
            "categories": "general",
            "maxResults": 3
        },
    ]

    try:
        tester.run_tests(test_cases)
    except KeyboardInterrupt:
        print("\nTest interrupted by user.")
        sys.exit(1)
    except Exception as e:
        print(f"Critical error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()