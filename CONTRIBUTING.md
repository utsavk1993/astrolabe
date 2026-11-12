# 🤝 Contributing to Astrolabe

Thanks for your interest in improving Astrolabe! Bug reports, ideas and pull requests are all welcome.

## 🐛 Reporting a bug

[Open an issue](https://github.com/utsavk1993/astrolabe/issues/new) and include:

- what you did, what you expected, and what happened instead
- your browser and operating system
- for hand control: your camera, and roughly how you were holding your hand
- for the AI features: the text or screenshot you used, if it's fine to share

## 💡 Suggesting a feature

Open an issue describing the problem it solves before writing code, so we can agree on the approach first. Small, focused changes are the easiest to review and merge.

## 🛠️ Setting up

There's no framework and no build step. You need Python 3.10+ and a browser.

```bash
git clone https://github.com/utsavk1993/astrolabe.git
cd astrolabe
cp .env.example .env    # then paste a free NVIDIA key after NVIDIA_API_KEY=
python3 server.py       # open http://localhost:8000
```

The clock and hand control work without a key; only the AI features need one. Edit a file and refresh the browser to see your change.

## 📂 Where things live

| File | What it does |
|---|---|
| `clock.js` | Draws the dial and the World time cards, and moves through time |
| `hands.js` | Webcam hand control (MediaPipe, runs in the browser) |
| `drop.js` | Drop, paste or type a time and send it to the AI |
| `meeting.js` | Finds and shows a meeting slot across cities |
| `tour.js` | The "What can it do?" guide |
| `api/_core.py` | The AI endpoint: prompt, reply parsing and rate limits |
| `server.py` | Local server; on Vercel, `api/*.py` serve the same routes |

## ✅ Before opening a pull request

1. Run the checks (the same ones GitHub runs on every push):

   ```bash
   for f in *.js; do node --check "$f" || exit 1; done
   python3 -m py_compile server.py api/*.py
   python3 -m unittest discover -s tests -v
   ```

2. Try your change in the browser at a laptop size (for example 1280×800 and 1440×900).
3. Keep it dependency-free: plain HTML, CSS and JavaScript in the browser, and the Python standard library on the server.
4. Never commit `.env` or any API key.
5. Describe what changed and why in the pull request, with a screenshot or short clip for anything visual.

## 📄 License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
