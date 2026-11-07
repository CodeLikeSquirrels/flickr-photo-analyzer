# Flickr Photo Analyzer

A local app that pulls your Flickr library and shows what's working: which photos people love, when to post, which tags pay off, where you shot, what your library is missing, and how views are trending.

Runs on your own computer: no cloud service, no sign-up, no dependencies.

## Get started

You need [Node.js](https://nodejs.org) 18 or newer. There's nothing to install: the app has no dependencies.

1. Download this repository (green **Code** button → **Download ZIP**, then unzip it), or clone it:
   ```
   git clone https://github.com/CodeLikeSquirrels/flickr-photo-analyzer.git
   ```
2. Start it:
   - **Windows:** double-click `start.bat`
   - **macOS / Linux:** run `./start.sh` (or `node server.js`)
3. Your browser opens at http://127.0.0.1:5177 and a setup screen walks you through the rest:
   - **Get a Flickr API key.** Flickr requires every app to have one. It's free and takes two minutes: the setup screen links to Flickr's form and gives you text to paste in.
   - **Enter the key and secret.** Paste them in (or paste the whole Flickr page and the app picks them out). The app checks them with Flickr before saving.
   - **Sign in to Flickr.** Approve read-only access and you're sent back to the app, where the first sync starts.

If Flickr shows you a code instead of returning to the app, use **Flickr showed a code instead?** on the sign-in step.

Don't want to sign in? You can analyze any public account from the same screen.

### Taskbar icon (Windows)

Run `launcher\build.bat` to make **Flickr Photo Analyzer.exe** next to `start.bat`. It uses the C# compiler built into Windows, so there's nothing to install. Right-click the exe and choose **Pin to taskbar** (on Windows 11, click **Show more options** first). Clicking it starts the app in a minimized window, or just opens it in your browser if it's already running.

### Privacy

Everything runs on your computer. The server only talks to Flickr; the page also loads its chart and map libraries from cdnjs and map tiles from OpenStreetMap. Your API key is saved in `config.json`, and your sign-in token and downloaded data are saved in the `data` folder. Both are listed in `.gitignore`, so they're never committed. The server only listens on 127.0.0.1 and rejects requests from other websites.

You can also supply the key through the `FLICKR_API_KEY` and `FLICKR_API_SECRET` environment variables, and change the port with `PORT`.

## What's in it

| Page | What it shows |
|---|---|
| Overview | Totals, fave and comment rates, plain-English insights, uploads per month, how views are spread, median views by upload year |
| Top photos | Most viewed, faved, discussed; best fave rate; fastest earners (views per day); recent hits; hidden gems |
| Last 28 days | Daily views by source, week-on-week change, trending photos, referring sites (Flickr Stats; needs Pro) |
| Timing | Upload and shooting heatmaps, upload day and hour vs. views, seasons, time from shot to upload |
| Tags | Tag cloud, strongest tags by median views, does tagging help |
| Map | Clustered map of geotagged photos, or circles sized by views |
| Albums | Views per album, median photo views, photos in no album |
| Movies | Your videos with their length, views, faves and comments; views by upload year and by length, compared with your photos |
| Cameras | Cameras, lenses, focal length, aperture, ISO, shutter, main camera each year (needs a background scan) |
| Explored | Your photos that made Flickr Explore, with the date and position (1–500). Needs a one-time background check of each day's Explore list; new days are checked automatically after that |
| Activity | Who faved and commented on your photos in the last 24 hours, 7, 14 or 30 days, with the busiest photos and most active people |
| Groups | Every group you're in, linked, with members, pool size, last activity, posting limits and a link to your photos in each pool |
| Contacts | Your contacts' newest uploads at the top, then everyone you follow, with links to their photostreams |
| Library health | Discoverability score; untitled, untagged, undescribed, unalbumed, ungeotagged photos with links to fix them |
| Explore | Filter and sort every photo; grid or table; CSV export |

Click any photo for details, live list of who faved it, groups it's in, and camera settings.

You can also analyze any public account (Accounts & settings → Analyze another public account).

## Caching and updates

Everything downloaded from Flickr is cached in the `data` folder and shown immediately on startup. The app then checks Flickr for changes in the background (also every 3 hours while it runs, and when you open it if the data is over an hour old; you can turn this off in Accounts & settings):

- The photo list is re-read for fresh view, fave and comment counts (one call per 500 photos).
- Album contents are only re-read for albums that changed.
- Daily stats are only fetched for days not already cached, plus the two newest days.
- New uploads get camera data automatically if you have used the camera scan.

Each check saves a daily snapshot of every photo's counts (kept for 120 days). The Overview's **What changed** panel compares against the last check or 1, 7, 30 or 90 days ago: views, faves and comments gained, the biggest gainers, new faves and comments, new uploads, and a growth chart.

## Notes

- Flickr allows 3,600 API calls an hour per key. A sync of 10,000 photos takes about 20 calls plus a few per album. The camera scan uses one call per photo, is throttled to stay under the limit, and can be stopped and resumed.
- Change your API key or sign out in **Accounts & settings**.
- Tests: `npm test` (Node 22+ for the test runner's file globbing).

## License

MIT. See [LICENSE](LICENSE).

This product uses the Flickr API but is not endorsed or certified by SmugMug, Inc. or Flickr.
