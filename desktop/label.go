package main

// The "AI-GENERATED" label that the launcher puts INSIDE every friend's video
// (DESIGN c.3): small PNGs ComfyUI composites over the frames, top-left, plus a
// 320x180 card that carries the AI song. Drawn with a 5x7 pixel font, so the
// pixels are exactly the same on every PC (the tests pin their sha256).

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
)

var labelGlyphs = map[rune][]string{
	'A': {".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"},
	'I': {"###", ".#.", ".#.", ".#.", ".#.", ".#.", "###"},
	'-': {"....", "....", "....", "####", "....", "....", "...."},
	'G': {".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."},
	'E': {"#####", "#....", "#....", "####.", "#....", "#....", "#####"},
	'N': {"#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"},
	'R': {"####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"},
	'T': {"#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."},
	'D': {"####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."},
}

const labelText = "AI-GENERATED"

var (
	labelBG    = color.NRGBA{10, 8, 20, 158}
	labelFG    = color.NRGBA{255, 255, 255, 255}
	labelCardC = color.NRGBA{10, 8, 20, 255}
)

func drawLabelText(img *image.NRGBA, x0, y0, s int) {
	b := img.Bounds()
	gx := 0
	rs := []rune(labelText)
	for k, ch := range rs {
		g := labelGlyphs[ch]
		for r, row := range g {
			for c, on := range row {
				if on != '#' {
					continue
				}
				for dy := 0; dy < s; dy++ {
					for dx := 0; dx < s; dx++ {
						X, Y := x0+(gx+c)*s+dx, y0+r*s+dy
						if X >= 0 && X < b.Dx() && Y >= 0 && Y < b.Dy() {
							img.SetNRGBA(X, Y, labelFG)
						}
					}
				}
			}
		}
		gx += len(g[0])
		if k < len(rs)-1 {
			gx++
		}
	}
}

// labelGeom: where the label goes on a W x H frame and how big it is.
type labelGeometry struct {
	File          string // ComfyUI input name, "glow/glowlabel_<W>x<H>.png"
	Scale, X, Y   int
	Width, Height int
}

func labelGeom(w, h int) labelGeometry {
	base := min(w, h)
	s := 2
	if base >= 600 {
		s = 3
	}
	m := int(jsRound(float64(0.04 * float64(base))))
	return labelGeometry{File: fmt.Sprintf("glow/glowlabel_%dx%d.png", w, h), Scale: s, X: m, Y: m, Width: 74 * s, Height: 11 * s}
}

// labelImage draws the semi-transparent capsule with the text.
func labelImage(scale int) *image.NRGBA {
	s := scale
	w, h := 74*s, 11*s
	r := float64(h) / 2
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			cx, cy := float64(x)+0.5, float64(y)+0.5
			dy := cy - float64(h)/2
			inside := (r <= cx && cx <= float64(w)-r && math.Abs(dy) <= r) ||
				(cx-r)*(cx-r)+dy*dy <= r*r ||
				(cx-(float64(w)-r))*(cx-(float64(w)-r))+dy*dy <= r*r
			if inside {
				img.SetNRGBA(x, y, labelBG)
			}
		}
	}
	drawLabelText(img, 3*s, 2*s, s)
	return img
}

// labelCardImage is the opaque card shown while the AI song plays (song.mp4).
func labelCardImage() *image.NRGBA {
	w, h, s := 320, 180, 3
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = labelCardC.R, labelCardC.G, labelCardC.B, labelCardC.A
	}
	drawLabelText(img, (w-68*s)/2, (h-7*s)/2, s)
	return img
}

func pngBytes(img image.Image) []byte {
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		panic(err) // in-memory encode of a valid image cannot fail
	}
	return b.Bytes()
}

// labelFiles are the four PNGs uploaded to ComfyUI's input\glow before every
// friend's job (name in input\glow -> PNG bytes).
func labelFiles() map[string][]byte {
	out := map[string][]byte{}
	for _, f := range [][2]int{{720, 1248}, {480, 832}, {384, 672}} {
		g := labelGeom(f[0], f[1])
		out[fmt.Sprintf("glowlabel_%dx%d.png", f[0], f[1])] = pngBytes(labelImage(g.Scale))
	}
	out["glowlabel_card.png"] = pngBytes(labelCardImage())
	return out
}
