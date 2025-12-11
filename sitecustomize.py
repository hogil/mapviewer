"""
Ensure pytest runs without auto-loading external plugins that emit noisy gzip close errors.

We disable plugin auto-load and rely on explicit plugins via pytest.ini addopts.
"""
import os

if os.getenv("PYTEST_DISABLE_PLUGIN_AUTOLOAD") is None:
    os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
