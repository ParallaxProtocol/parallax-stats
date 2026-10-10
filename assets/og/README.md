# Link preview background

`dashboard.png` is a 2000×1000 screenshot of the dashboard.
`dashboard-tilted.jpg` is the card's background, made from it by turning
it away in 3D (about 18° side to side and 12° top to bottom, scaled to
fill the card), blurring and darkening it. The best block number is painted
over first, since its digits stay legible through the blur:

```bash
magick dashboard.png -fill "rgb(8,10,17)" -draw "rectangle 40,50 330,215" \
  -background "#05060b" -virtual-pixel background -alpha set \
  -distort Perspective '0,0 -441,-174  2000,0 2800,-152  2000,1000 2690,1225  0,1000 -249,1622' \
  -crop 2400x1260+0+0 +repage -flatten -blur 0x6 -fill "#05060b" -colorize 8% \
  -resize 1200x630! -quality 88 -strip dashboard-tilted.jpg
```

Re-run it after replacing the screenshot when the dashboard's look changes.
