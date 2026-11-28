param([string]$Tag)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class F { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
 public static string D(IntPtr h){ var c=new StringBuilder(256); var t=new StringBuilder(256); GetClassName(h,c,256); GetWindowText(h,t,256); return c+"/"+t; }
 public static string At(int x,int y){ POINT p; p.X=x; p.Y=y; return D(WindowFromPoint(p)); } }
"@
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$pts = @(@(0.5,0.5), @(0.1,0.5), @(0.9,0.5), @(0.5,0.9), @(0.05,0.03), @(0.5,0.05), @(0.5,0.99))
$out = foreach ($p in $pts) { $c = $bmp.GetPixel([int]($b.Width*$p[0]), [int]($b.Height*$p[1])); "{0},{1}={2},{3},{4}" -f $p[0],$p[1],$c.R,$c.G,$c.B }
Write-Output ("[screen] $Tag fg=" + [F]::D([F]::GetForegroundWindow()) + " at-center=" + [F]::At(512,384) + " " + ($out -join ' | ') + " virtual=" + $b)
