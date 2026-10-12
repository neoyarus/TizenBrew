# YouTube TV startup splash

This dedicated TizenTube build uses the original YouTube TV startup image and loader layout while TizenBrew starts its service and debugger. It displays the YouTube splash during every startup, including the brief wait before a manual menu. This is a deliberate choice for the user's single-module TV installation; a general-purpose upstream build should select its splash from the configured startup module instead.

Source: https://www.youtube.com/tv, retrieved on 2026-10-11 using the TV's user agent. The PNG was extracted unchanged from the page's `#loader` CSS data URL. The loader has a fullscreen `#282828` background, centered non-repeating image, and `background-size: 60%`. Those rules are reproduced in `index.html` for both the initial HTML and the Preact startup surface.

Original asset: `youtube-tv-splash.png`, 1,984 × 444 pixels, 15,190 bytes.

SHA-256: `f44dd062f246db3a252c80ad093160507b30f6c80de202bcb958732a8ac2d39d`.

The same unchanged PNG bytes are embedded as a data URL in `index.html`, so the initial splash needs no network request or separate asset load. The source PNG is retained here for provenance and verification.

The YouTube logo and artwork belong to YouTube/Google. This asset is third-party material; its inclusion does not change its ownership or place it under TizenBrew's source-code license.

The native splash at `../../../res/youtube-tv-native-splash.png` is a 1,920 × 1,080 screenshot of that same YouTube TV boot page rendered on the target TV with page scripts temporarily paused. It contains only the splash artwork and background. Its 36,477 bytes have SHA-256 `f32a626119fc0d3aacb595843db6359043bd897e47fb484c78725b3905b2f14f`. The Samsung `video_splash_screen` declaration uses this static frame with a `first-paint` handoff; native overlay behavior needs visual confirmation on each firmware.
