param([string]$Tag)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$pts = @(@(0.5,0.5), @(0.1,0.5), @(0.9,0.5), @(0.5,0.9), @(0.05,0.03))
$out = foreach ($p in $pts) { $c = $bmp.GetPixel([int]($b.Width*$p[0]), [int]($b.Height*$p[1])); "{0},{1}={2},{3},{4}" -f $p[0],$p[1],$c.R,$c.G,$c.B }
Write-Output ("[screen] $Tag " + ($out -join ' | ') + " virtual=" + $b)
