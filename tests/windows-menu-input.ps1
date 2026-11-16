param(
  [Parameter(Mandatory=$true)][int]$ApplicationPid,
  [Parameter(Mandatory=$true)][string]$Keys,
  [Parameter(Mandatory=$true)][string]$EvidencePath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MenuFixture {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr state);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr state);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    public static IntPtr Find(uint pid, bool menu) {
        IntPtr found=IntPtr.Zero;
        EnumWindows((hwnd,state)=>{
            uint owner; GetWindowThreadProcessId(hwnd,out owner);
            if(owner!=pid || !IsWindowVisible(hwnd))return true;
            var text=new StringBuilder(256);GetClassName(hwnd,text,256);
            RECT rect; GetClientRect(hwnd,out rect);
            if(menu ? text.ToString()=="#32768" : rect.right>=800 && rect.bottom>=600){found=hwnd;return false;}
            return true;
        },IntPtr.Zero);
        return found;
    }
}
'@
$owner = [MenuFixture]::Find($ApplicationPid,$false)
if ($owner -eq [IntPtr]::Zero) { throw '本次测试应用没有可见主窗口' }
if ($Keys -eq 'FOCUS') { return }
$popup = [MenuFixture]::Find($ApplicationPid,$true)
if ($popup -eq [IntPtr]::Zero) { throw '本次测试应用没有原生弹出菜单' }
$rect = New-Object MenuFixture+RECT
[void][MenuFixture]::GetClientRect($owner,[ref]$rect)
$bitmap = New-Object System.Drawing.Bitmap($rect.right,$rect.bottom)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$dc = $graphics.GetHdc()
try { $captured = [MenuFixture]::PrintWindow($owner,$dc,3) }
finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
try {
  if (!$captured) { throw '无法获取测试应用渲染快照' }
  $bitmap.Save($EvidencePath,[System.Drawing.Imaging.ImageFormat]::Png)
  $color=$bitmap.GetPixel($rect.right-40,$rect.bottom-40)
  if ($color.R -ne 18 -or $color.G -ne 90 -or $color.B -ne 130) { throw ('菜单期间站点像素错误：{0},{1},{2}' -f $color.R,$color.G,$color.B) }
} finally { $bitmap.Dispose() }
if ($Keys -ne '{ESC}') { throw '仅支持取消本次测试进程的原生菜单' }
[void][MenuFixture]::PostMessage($owner,0x001F,[IntPtr]::Zero,[IntPtr]::Zero)
