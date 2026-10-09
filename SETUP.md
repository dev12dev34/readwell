# Readwell for iPhone: setup guide

Readwell for iPhone is a free Home Screen app. It's hosted on GitHub Pages at no cost and works offline after the first launch.

## 1. Put it online (about 5 minutes, once)
1. Unzip **readwell-phone.zip** on your Mac.
2. Go to github.com and sign up for a free account. Your username becomes part of the web address.
3. Click **+** (top right) → **New repository**. Name it `readwell`, choose **Public**, and click **Create repository**.
4. On the next page, click **uploading an existing file**.
5. Open the unzipped **readwell-phone** folder, press ⌘A to select everything inside it, and drag it all onto the GitHub page. Drag the contents, not the folder itself. Wait for the upload to finish, then click **Commit changes**.
6. Open the repository's **Settings** → **Pages**. Under "Branch", choose **main** and **/(root)**, then click **Save**.
7. After a minute or two, your app is live at `https://YOUR-USERNAME.github.io/readwell/`.

## 2. Install it on the iPhone
1. Open that address in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open Readwell from the Home Screen icon. It now works offline, including text recognition.

To share the app, send someone the link. Each phone keeps its own library.

## 3. Natural AI voices (free)
In Readwell, tap the 🗣 voice button (or Settings → Voice) → **Download AI voices**. It's a one-time download of about 100 MB (use Wi-Fi), and the voices work offline afterwards. You get 17 Kokoro voices, the same ones as the Mac app. ★ Heart, Bella, Michael, Emma and George are the best to start with.

- The voice files come directly from Hugging Face and jsDelivr, which host these open-source files for free. You don't need to upload anything extra to GitHub.
- Newer iPhones (2021 or later) work best. The voice menu shows how fast your phone makes speech. On older phones there may be short pauses between sentences.
- Apple's free **Premium** voices are another option: Settings app → Accessibility → Spoken Content → Voices → English.

## Updating the app later
Upload the changed files to the same repository, replacing the old ones (same steps as above: **Add file → Upload files**, drag, **Commit changes**). Update `VERSION` in `sw.js` at the same time. Phones pick up the new version the next time Readwell is opened.

## Good to know
- Readwell keeps the screen awake while it reads.
- The dictionary, synonyms and opening links need the internet. Words you've looked up before work offline.
- Your library stays on the phone. Use **Settings → Back up everything** now and then. Removing the icon from the Home Screen deletes the library.
- MP3 export is Mac-only.
- With an AI voice selected, reading may continue with the screen locked, and you get lock-screen play/pause controls. With iPhone voices, reading stops when the screen locks.
