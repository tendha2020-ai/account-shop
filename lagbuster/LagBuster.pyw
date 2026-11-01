"""Double-click to start LagBuster (Windows runs .pyw files without a console window).

Needs Python 3.10+ and the packages in requirements.txt - or just use run_lagbuster.bat,
which installs them for you.
"""

import sys

from lagbuster.__main__ import main

sys.exit(main())
