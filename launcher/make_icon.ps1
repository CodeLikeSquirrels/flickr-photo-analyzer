# Draws the app icon (a rising bar chart on a dark tile) and writes launcher\app.ico
# with 16-256 px sizes, plus public\icon.png for the browser tab.
# Run: powershell -ExecutionPolicy Bypass -File launcher\make_icon.ps1
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function New-IconBitmap([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)

  # rounded dark tile
  $r = [single]($s * 0.22); $d = 2 * $r; $w = [single]($s - 1)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($w - $d, 0, $d, $d, 270, 90)
  $path.AddArc($w - $d, $w - $d, $d, $d, 0, 90); $path.AddArc(0, $w - $d, $d, $d, 90, 90); $path.CloseFigure()
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0, 0)), ([System.Drawing.PointF]::new(0, $s)), ([System.Drawing.Color]::FromArgb(255, 36, 41, 58)), ([System.Drawing.Color]::FromArgb(255, 16, 18, 26))
  $g.FillPath($bg, $path)

  # three rising bars: blue, violet, pink
  $cols = @([System.Drawing.Color]::FromArgb(255, 74, 140, 255), [System.Drawing.Color]::FromArgb(255, 140, 110, 255), [System.Drawing.Color]::FromArgb(255, 255, 72, 150))
  $heights = @(0.30, 0.48, 0.66)
  $pad = $s * 0.19; $gap = $s * 0.07; $base = $s * 0.80
  $bw = ($s - 2 * $pad - 2 * $gap) / 3
  for ($i = 0; $i -lt 3; $i++) {
    $x = [single]($pad + $i * ($bw + $gap)); $h = [single]($s * $heights[$i]); $y = [single]($base - $h)
    $br = New-Object System.Drawing.SolidBrush $cols[$i]
    $rr = [single][Math]::Max(1, $bw * 0.28); $dd = 2 * $rr
    $bar = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bar.AddArc($x, $y, $dd, $dd, 180, 90); $bar.AddArc($x + $bw - $dd, $y, $dd, $dd, 270, 90)
    $bar.AddLine($x + $bw, $base, $x, $base); $bar.CloseFigure()
    $g.FillPath($br, $bar)
  }
  $g.Dispose()
  return $bmp
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) {
  $b = New-IconBitmap $s; $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose(); , $ms.ToArray()
}

# ICO file: header, directory, then PNG images
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$pngs[$i].Length); $bw.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $here 'app.ico'), $out.ToArray())
[System.IO.File]::WriteAllBytes((Join-Path (Split-Path -Parent $here) 'public\icon.png'), $pngs[4])
Write-Host "Wrote launcher\app.ico and public\icon.png"
