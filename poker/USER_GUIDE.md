# Poker App - User Guide

Welcome to the Poker App! This guide will help you get started playing Texas Hold'em against AI opponents.

## Table of Contents

- [Quick Start](#quick-start)
- [Game Rules](#game-rules)
- [How to Play](#how-to-play)
- [Interface Guide](#interface-guide)
- [Features](#features)
- [Settings & Customization](#settings--customization)
- [Tips & Strategy](#tips--strategy)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

1. Visit https://palmergill.com/poker/
2. Enter your name
3. Click "Play vs AI" for a single-player cash game, "Sit-and-Go Tournament" for a single-table SNG against AI, or create/join a multiplayer game
4. Single-player and tournament modes start automatically against five named AI opponents

---

## Game Rules

### Texas Hold'em Basics

This app plays **No-Limit Texas Hold'em**, the most popular poker variant.

#### The Setup

- Each player gets 2 private cards (hole cards)
- 5 community cards are dealt face-up in the center
- Players make the best 5-card hand using any combination of their hole cards and community cards

#### Betting Rounds

1. **Pre-flop**: After receiving hole cards
2. **Flop**: After first 3 community cards
3. **Turn**: After 4th community card
4. **River**: After 5th community card
5. **Showdown**: Players reveal hands if needed

#### Hand Rankings (Best to Worst)

| Rank | Hand | Example |
|------|------|---------|
| 1 | Royal Flush | A♠ K♠ Q♠ J♠ 10♠ |
| 2 | Straight Flush | 5♥ 6♥ 7♥ 8♥ 9♥ |
| 3 | Four of a Kind | K♠ K♥ K♦ K♣ 2♠ |
| 4 | Full House | Q♠ Q♥ Q♦ 7♣ 7♥ |
| 5 | Flush | A♦ 10♦ 7♦ 4♦ 2♦ |
| 6 | Straight | 5♠ 6♥ 7♦ 8♣ 9♠ |
| 7 | Three of a Kind | 8♠ 8♥ 8♦ A♣ 2♠ |
| 8 | Two Pair | J♠ J♥ 5♦ 5♣ A♠ |
| 9 | One Pair | 10♠ 10♥ A♦ 7♣ 2♠ |
| 10 | High Card | A♠ K♦ 10♥ 7♣ 3♠ |

#### Blinds

- **Small Blind**: Forced bet before cards are dealt (10 chips)
- **Big Blind**: Forced bet, usually double the small blind (20 chips)
- Blinds rotate each hand

---

## How to Play

### Your Turn

When it's your turn, you have several options:

| Action | When to Use |
|--------|-------------|
| **Fold** | Give up your hand if you think you can't win |
| **Check** | Pass the action (only if no bet to call) |
| **Call** | Match the current bet to stay in the hand |
| **Raise** | Increase the bet amount |
| **All-in** | Bet all your remaining chips |

### Betting Tips

- **Minimum raise**: Current bet + last raise amount
- **No maximum**: You can bet all your chips anytime
- **Pot odds**: The app shows your pot odds to help decisions

---

## Interface Guide

### Main Screen

```
┌─────────────────────────────────────┐
│  Pot: 150 chips    Odds: 3:1        │  ← Top bar
├─────────────────────────────────────┤
│                                     │
│    [AI Players - Top]               │  ← Opponents
│                                     │
├─────────────────────────────────────┤
│                                     │
│         [Community Cards]           │  ← The Board
│                                     │
├─────────────────────────────────────┤
│                                     │
│    [Your Cards]    [Hand Strength]  │  ← Your area
│                                     │
├─────────────────────────────────────┤
│  [Fold] [Check] [Call] [Raise]      │  ← Action buttons
└─────────────────────────────────────┘
```

### Visual Indicators

| Element | Meaning |
|---------|---------|
| 🟡 Yellow border | It's your turn |
| 🔴 Red "FOLDED" badge | Player has folded |
| 🟢 Green chips | Active player |
| ⏱️ Timer bar | Time remaining (30 seconds) |
| 💰 Pot display | Total chips in the pot |

### Hand Strength Indicator

Below your cards, you'll see your current hand strength:
- "Pair of Aces"
- "Flush Draw"
- "Straight"
- etc.

This updates as community cards are dealt.

---

## Features

### Sound Effects

- Card dealing sounds
- Chip movement sounds
- Win/loss notifications

**Note**: Sounds require a user interaction first (click anywhere) due to browser autoplay policies.

### Haptic Feedback

On mobile devices, you'll feel a vibration when it's your turn.

### Player Statistics

Click "Stats" on the start screen to view:
- Hands played/won
- Win rate percentage
- Biggest pot won
- Net profit/loss
- Best hand achieved
- Last 20 hands with result, hole cards, board, and P/L

Stats persist across sessions using browser storage. The hand history can be cleared independently with the "Clear" control in the modal.

### Sit-and-Go Tournament

Click "Sit-and-Go Tournament" on the start screen to play a single-table SNG against the same five AI opponents. Everyone starts with 1500 chips and a 12-level blind schedule escalates every six hands. The in-game banner shows the current level, blinds, hands until the next level, and players remaining; eliminations are tracked in order so finishing position is preserved.

### Multiplayer

Use "Create Multiplayer Game" to create a lobby and share the Game ID. The host can start once at least two players have joined. Use "Join Multiplayer Game" to enter an existing lobby.

---

## Settings & Customization

### Table Themes

Click the theme button (🎨) to choose:
- **Green** - Classic casino felt
- **Blue** - Cool blue tone
- **Red** - Bold red felt
- **Black** - Modern dark
- **Purple** - Rich purple

### Card Deck Themes

Click the cards button (🃏) to change card style:
- **Classic** - Traditional design
- **Modern** - Sleek rounded corners
- **Minimal** - Clean and simple
- **Vintage** - Aged paper look
- **Neon** - Cyberpunk glow (great for dark mode)

### Dark Mode

Click the moon/sun button (🌙/☀️) to toggle between light and dark modes. Your preference is saved.

### PWA Installation

You can install the app on your device:

**iOS Safari:**
1. Tap Share button
2. Select "Add to Home Screen"

**Android Chrome:**
1. Tap menu (⋮)
2. Select "Add to Home screen"

**Desktop Chrome:**
1. Click install icon in address bar
2. Or use menu → Install Poker App

---

## Tips & Strategy

### Starting Hands

**Strong hands** (raise):
- AA, KK, QQ, AK suited

**Good hands** (call/raise):
- JJ, TT, AQ, AJ suited, KQ suited

**Marginal hands** (careful):
- Low pairs, suited connectors

**Weak hands** (usually fold):
- Unsuited low cards, disconnected hands

### Position Matters

- **Dealer (Button)**: Best position - act last
- **Early position**: Act first - play tighter
- **Late position**: Can play more hands

### Reading the Board

Watch for:
- **Flush draws**: 3 cards of same suit
- **Straight draws**: Sequential cards
- **Paired board**: Possible full houses

### Bluffing

AI opponents have distinct personality archetypes labeled on each seat:

| Bot | Archetype | What to expect |
|-----|-----------|---------------|
| Reg | Tight-Aggressive (TAG) | Folds weak hands, bets value hard. |
| Cal | Loose-Passive (LP) | Calls too much; raise for value, fold to its aggression. |
| Action Jackson | Maniac | Bets and raises light; trap with strong hands. |
| Stone | Rock | Folds almost everything; respect a raise. |
| Avery | Standard | Balanced baseline. |

Adjust your strategy by opponent.

---

## Troubleshooting

### Game Won't Load

1. Check internet connection
2. Try refreshing the page
3. Clear browser cache
4. Try a different browser

### Buttons Not Responding

1. Ensure it's your turn (yellow border)
2. Check if timer ran out (auto-fold)
3. Refresh and rejoin game

### Sounds Not Playing

1. Click/tap anywhere on the page first
2. Check device volume
3. Ensure not in silent mode (mobile)

### Game Feels Slow

1. Check internet connection
2. Close other browser tabs
3. Try on a device with more RAM

### Lost Connection

The game uses a WebSocket push channel for live updates and falls back to polling when the socket is unavailable. If neither recovers:
1. Refresh the page
2. Use the same game ID if you have it

---

## Need Help?

Found a bug or have a suggestion?

- Open an issue on GitHub
- Check the task list at `poker/TASKS.md`
- Review the changelog at `poker/CHANGELOG.md`

---

**Good luck at the tables!**
