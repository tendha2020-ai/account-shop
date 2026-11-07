package main

// Friends' uploads (DESIGN b.4): the launcher decodes the selfie and the
// lip-sync song part itself and writes new files, so ComfyUI (PIL, PyAV) only
// ever reads bytes Go produced: no EXIF, ICC or other metadata, no odd formats.

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
)

var badPhoto = &apiError{Status: 400, Code: "bad-photo", Message: "This photo couldn't be read. Try another photo (JPEG or PNG).", Field: "selfie"}

const (
	selfieMaxSide = 1536
	thumbSide     = 160
)

// sanitizeSelfie checks a JPEG/PNG selfie and re-encodes it (long side <= 1536,
// JPEG quality 92). With thumb, it also makes the host's 160 px approval thumbnail.
func sanitizeSelfie(data []byte, thumb bool) (out, th []byte, e *apiError) {
	isJPEG := len(data) > 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF
	isPNG := len(data) > 8 && bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n"))
	if !isJPEG && !isPNG {
		return nil, nil, &apiError{Status: 415, Code: "unsupported-type", Message: "Please use a JPEG or PNG photo.", Field: "selfie"}
	}
	var cfg image.Config
	var err error
	if isJPEG {
		cfg, err = jpeg.DecodeConfig(bytes.NewReader(data))
	} else {
		cfg, err = png.DecodeConfig(bytes.NewReader(data))
	}
	if err != nil || cfg.Width < 128 || cfg.Height < 128 || cfg.Width > 6000 || cfg.Height > 6000 || cfg.Width*cfg.Height > 24_000_000 {
		return nil, nil, badPhoto
	}
	var img image.Image
	if isJPEG {
		img, err = jpeg.Decode(bytes.NewReader(data))
	} else {
		img, err = png.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, nil, badPhoto
	}
	b := img.Bounds()
	if b.Dx() != cfg.Width || b.Dy() != cfg.Height {
		return nil, nil, badPhoto
	}
	// flatten onto white (a PNG may be see-through)
	rgba := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(rgba, rgba.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(rgba, rgba.Bounds(), img, b.Min, draw.Over)
	img = nil
	small := downscale(rgba, selfieMaxSide)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, small, &jpeg.Options{Quality: 92}); err != nil {
		return nil, nil, badPhoto
	}
	if thumb {
		var tb bytes.Buffer
		if jpeg.Encode(&tb, downscale(small, thumbSide), &jpeg.Options{Quality: 80}) == nil {
			th = tb.Bytes()
		}
	}
	return buf.Bytes(), th, nil
}

// downscale shrinks so the long side is at most maxSide, averaging the source
// pixels under each new pixel (a box filter; stdlib only).
func downscale(src *image.RGBA, maxSide int) *image.RGBA {
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	long := max(w, h)
	if long <= maxSide {
		return src
	}
	dw := max(1, (w*maxSide+long/2)/long)
	dh := max(1, (h*maxSide+long/2)/long)
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	xs := make([][2]int, dw)
	for x := 0; x < dw; x++ {
		x0, x1 := x*w/dw, (x+1)*w/dw
		if x1 <= x0 {
			x1 = x0 + 1
		}
		xs[x] = [2]int{x0, x1}
	}
	acc := make([]uint64, dw*4)
	for y := 0; y < dh; y++ {
		y0, y1 := y*h/dh, (y+1)*h/dh
		if y1 <= y0 {
			y1 = y0 + 1
		}
		clear(acc)
		for sy := y0; sy < y1; sy++ {
			row := src.Pix[sy*src.Stride:]
			for x := 0; x < dw; x++ {
				a := acc[x*4 : x*4+4]
				for sx := xs[x][0]; sx < xs[x][1]; sx++ {
					p := row[sx*4 : sx*4+4]
					a[0] += uint64(p[0])
					a[1] += uint64(p[1])
					a[2] += uint64(p[2])
					a[3] += uint64(p[3])
				}
			}
		}
		out := dst.Pix[y*dst.Stride:]
		for x := 0; x < dw; x++ {
			n := uint64((xs[x][1] - xs[x][0]) * (y1 - y0))
			for c := 0; c < 4; c++ {
				out[x*4+c] = uint8((acc[x*4+c] + n/2) / n)
			}
		}
	}
	return dst
}

var badAudio = &apiError{Status: 400, Code: "bad-audio", Message: "The song part couldn't be read. Pick the song again.", Field: "audio"}

// sanitizeWAV checks the lip-sync song part (RIFF/WAVE, PCM 16-bit mono,
// 8-48 kHz, 5-30 s) and rewrites it with a plain 44-byte header.
func sanitizeWAV(data []byte) (out []byte, seconds float64, e *apiError) {
	if len(data) < 12 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return nil, 0, badAudio
	}
	var rate uint32
	var gotFmt bool
	var pcm []byte
	for off := 12; off+8 <= len(data); {
		id := string(data[off : off+4])
		size := int64(binary.LittleEndian.Uint32(data[off+4 : off+8]))
		body := off + 8
		if size > int64(len(data)-body) {
			return nil, 0, badAudio
		}
		chunk := data[body : body+int(size)]
		switch id {
		case "fmt ":
			if len(chunk) < 16 || gotFmt {
				return nil, 0, badAudio
			}
			format := binary.LittleEndian.Uint16(chunk[0:2])
			channels := binary.LittleEndian.Uint16(chunk[2:4])
			rate = binary.LittleEndian.Uint32(chunk[4:8])
			bits := binary.LittleEndian.Uint16(chunk[14:16])
			if format != 1 || channels != 1 || bits != 16 || rate < 8000 || rate > 48000 {
				return nil, 0, badAudio
			}
			gotFmt = true
		case "data":
			if !gotFmt || pcm != nil || size%2 != 0 {
				return nil, 0, badAudio
			}
			pcm = chunk
		}
		off = body + int(size) + int(size&1)
	}
	if !gotFmt || pcm == nil {
		return nil, 0, badAudio
	}
	seconds = float64(len(pcm)/2) / float64(rate)
	if seconds < 5 || seconds > 30 {
		return nil, 0, &apiError{Status: 400, Code: "bad-audio", Message: "The song part must be 5 to 30 seconds long.", Field: "audio"}
	}
	out = make([]byte, 44+len(pcm))
	copy(out[0:], "RIFF")
	binary.LittleEndian.PutUint32(out[4:], uint32(36+len(pcm)))
	copy(out[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(out[16:], 16)
	binary.LittleEndian.PutUint16(out[20:], 1)
	binary.LittleEndian.PutUint16(out[22:], 1)
	binary.LittleEndian.PutUint32(out[24:], rate)
	binary.LittleEndian.PutUint32(out[28:], rate*2)
	binary.LittleEndian.PutUint16(out[32:], 2)
	binary.LittleEndian.PutUint16(out[34:], 16)
	copy(out[36:], "data")
	binary.LittleEndian.PutUint32(out[40:], uint32(len(pcm)))
	copy(out[44:], pcm)
	return out, seconds, nil
}
