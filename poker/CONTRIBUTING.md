# Contributing to the Poker App

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Getting Started

### Prerequisites

- Python 3.11+
- Node.js 18+ (for frontend tooling)
- Git

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/palmergill.com.git
   cd palmergill.com
   ```

3. Set up the shared backend:
   ```bash
   cd backend
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

4. Install root JavaScript dependencies:
   ```bash
   cd ..
   npm install
   ```

## Development Workflow

### Running the Backend Locally

```bash
./start.sh
```

The local site and API will be available at `http://127.0.0.1:8000`. The local `/docs` route is FastAPI's generated API docs; the static website docs page is served by production/static hosting at `/docs/`.

### Frontend Development

The active frontend is vanilla HTML/CSS/JS in `poker/`. With `./start.sh`, open:

```text
http://127.0.0.1:8000/poker/
```

### Running Tests

```bash
npm test
```

The root Jest config runs frontend tests for poker, craps, and blackjack.

## Code Style

### Python

- Follow PEP 8
- Use type hints where possible
- Maximum line length: 100 characters
- Use docstrings for public functions

Example:
```python
def calculate_pot(players: list[Player]) -> int:
    """Calculate the total pot from all player bets.
    
    Args:
        players: List of active players in the hand
        
    Returns:
        Total pot size in chips
    """
    return sum(p.current_bet for p in players)
```

### JavaScript

- Use ES6+ features
- Prefer `const` and `let` over `var`
- Use camelCase for variables/functions
- Use PascalCase for classes
- Add JSDoc comments for complex functions

## Making Changes

### Branch Naming

- `feature/description` - New features
- `bugfix/description` - Bug fixes
- `docs/description` - Documentation updates
- `refactor/description` - Code refactoring

### Commit Messages

Use clear, descriptive commit messages:

```
[docs] Clarify active poker API

- Document shared backend endpoints
- Update related setup notes
```

Use a short prefix when it helps, but keep the subject focused on the behavior or docs changed.

## Submitting Changes

1. Create a new branch for your changes
2. Make your changes with clear commits
3. Add/update tests as needed
4. Ensure relevant tests pass
5. Update relevant documentation
6. Push to your fork
7. Create a Pull Request

### Pull Request Guidelines

- Provide a clear description of changes
- Reference any related issues
- Ensure CI checks pass
- Request review from maintainers

## Areas Needing Help

Check `TASKS.md` for incomplete tasks. Priority areas:

- **Testing**: Add tests for the active shared poker router
- **Documentation**: User guides, API docs
- **Reliability**: Reconnect/backoff hardening on the WebSocket push channel

## Reporting Issues

When reporting bugs, please include:

- Browser/device info
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if applicable
- Error messages from console

## Code of Conduct

- Be respectful and inclusive
- Welcome newcomers
- Focus on constructive feedback
- Assume good intentions

## Questions?

Open an issue or reach out to the maintainers.

---

Thank you for contributing! 🎉
