import os
import sys
import tempfile
from pathlib import Path

# Make "import lagbuster" work when running pytest from the lagbuster/ folder.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Keep tests away from the real settings/undo files.
os.environ.setdefault("LAGBUSTER_HOME", tempfile.mkdtemp(prefix="lagbuster-test-"))
