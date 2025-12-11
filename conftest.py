import os
import sys

# Disable langsmith plugin side effects (noisy gzip close errors) if autoloaded.
os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")


def pytest_configure(config):
    pm = config.pluginmanager
    for plugin in list(pm.get_plugins()):
        mod = getattr(plugin, "__module__", "") or ""
        if mod.startswith("langsmith"):
            pm.unregister(plugin)
    # Also block future loads
    pm.set_blocked("langsmith")
    pm.set_blocked("langsmith.pytest_plugin")
