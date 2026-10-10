# Vendored fonts

`Geist-SemiBold.ttf` and `Geist-Light.ttf`, from Google Fonts (Geist v5),
copied from parallax-website. Licensed under the SIL Open Font License 1.1.

They exist as files because the link preview card in
`src/app/opengraph-image.tsx` is rendered by Satori, which needs raw font
data and cannot read WOFF2. Kept out of `public/` so they are not served.
