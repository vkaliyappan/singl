# World Clock desktop widget - soft glassy themes, draggable, pin-on-top or normal window.
# Drag with left mouse. Right-click for settings. Clocks, settings + position live in config.json next to this script.
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$configPath = Join-Path $PSScriptRoot 'config.json'
$launcherPath = Join-Path $PSScriptRoot 'WorldClock.vbs'
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'World Clock.lnk'
$enUS = [Globalization.CultureInfo]'en-US'

$settingDefaults = [ordered]@{
    Use24h      = $true
    ShowSeconds = $false
    ShowDetails = $true
    Scale       = 1.0
    Opacity     = 0.95
    Theme       = 'Mist'
    Topmost     = $true
    Locked      = $false
}

# Soft card gradients (top-left -> bottom-right). Mode picks the text/glass palette below.
$themes = [ordered]@{
    Pearl    = @{ Mode = 'Light'; Stops = @('#FFFFFF', '#F3F4F7', '#E7E9EF') }
    Mist     = @{ Mode = 'Light'; Stops = @('#F2F6FF', '#E3ECFB', '#D6E2F5') }
    Blush    = @{ Mode = 'Light'; Stops = @('#FFF4EE', '#FBE4EA', '#EEDDF6') }
    Sage     = @{ Mode = 'Light'; Stops = @('#F4F7F1', '#E5EDE0', '#D6E3D0') }
    Sand     = @{ Mode = 'Light'; Stops = @('#FBF7F1', '#F1E8DA', '#E6D8C3') }
    Lilac    = @{ Mode = 'Light'; Stops = @('#F7F4FF', '#ECE6FC', '#DDD5F5') }
    Graphite = @{ Mode = 'Dark';  Stops = @('#34363C', '#26282D', '#1C1D21') }
    Midnight = @{ Mode = 'Dark';  Stops = @('#26304A', '#1B2236', '#131826') }
    Aurora   = @{ Mode = 'Dark';  Stops = @('#1D2B36', '#1C3A40', '#22324A') }
    Plum     = @{ Mode = 'Dark';  Stops = @('#382C44', '#2A2133', '#1E1825') }
    Espresso = @{ Mode = 'Dark';  Stops = @('#3A302A', '#2B2420', '#1F1A17') }
    Forest   = @{ Mode = 'Dark';  Stops = @('#26392F', '#1D2C25', '#16201B') }
}

$palettes = @{
    Light = @{
        Fg = '#1D1D1F'; Sub = '#6E6E73'; Vibe = '#3A3A3C'
        Row = @('#FFFFFF', 0.62); RowBorder = @('#FFFFFF', 0.9); CardBorder = @('#FFFFFF', 0.95); Track = @('#000000', 0.07)
        DayBg = '#FFF1D6'; DayFg = '#D98A00'; NightBg = '#E6E8FF'; NightFg = '#5B5FC7'
    }
    Dark = @{
        Fg = '#F5F5F7'; Sub = '#A1A1A6'; Vibe = '#D1D1D6'
        Row = @('#FFFFFF', 0.06); RowBorder = @('#FFFFFF', 0.08); CardBorder = @('#FFFFFF', 0.10); Track = @('#FFFFFF', 0.10)
        DayBg = '#4A3B1E'; DayFg = '#FBC54A'; NightBg = '#2E3160'; NightFg = '#A5B4FC'
    }
}

# Per-city accent colours for the day-progress bar, cycled
$accents = @('#F5A524', '#17C27F', '#3B82F6', '#EC4899', '#8B5CF6', '#F97316')

# Fun status by local hour in that city
function Get-Vibe([int]$h) {
    switch ($h) {
        { $_ -lt 5 }  { 'Zzz... snoozing'; break }
        { $_ -lt 7 }  { 'Early bird mode'; break }
        { $_ -lt 9 }  { 'Coffee o''clock'; break }
        { $_ -lt 12 } { 'Crushing it'; break }
        { $_ -lt 14 } { 'Lunch munch time'; break }
        { $_ -lt 17 } { 'Hustle hours'; break }
        { $_ -lt 19 } { 'Golden hour'; break }
        { $_ -lt 22 } { 'Couch & chill'; break }
        default       { 'Winding down' }
    }
}

function Get-Config {
    if (-not (Test-Path $configPath)) {
        $default = [ordered]@{
            Left   = 100
            Top    = 100
            Clocks = @(
                [ordered]@{ Label = 'Chennai';  Zone = 'India Standard Time' }
                [ordered]@{ Label = 'London';   Zone = 'GMT Standard Time' }
                [ordered]@{ Label = 'New York'; Zone = 'Eastern Standard Time' }
                [ordered]@{ Label = 'San Jose'; Zone = 'Pacific Standard Time' }
                [ordered]@{ Label = 'Tokyo';    Zone = 'Tokyo Standard Time' }
            )
        }
        $default | ConvertTo-Json -Depth 4 | Set-Content -Path $configPath -Encoding UTF8
    }
    $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
    # Fill settings missing from older config files
    foreach ($k in $settingDefaults.Keys) {
        if ($cfg.PSObject.Properties.Name -notcontains $k) { $cfg | Add-Member -NotePropertyName $k -NotePropertyValue $settingDefaults[$k] }
    }
    if (-not $themes.Contains([string]$cfg.Theme)) { $cfg.Theme = $settingDefaults.Theme }
    $cfg.Clocks = @($cfg.Clocks | Where-Object { $_ })
    $cfg
}

function Save-Config {
    $script:config.Left = [int]$window.Left
    $script:config.Top = [int]$window.Top
    $script:config | ConvertTo-Json -Depth 4 | Set-Content -Path $configPath -Encoding UTF8
}

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="World Clock" WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="True" ResizeMode="CanMinimize" SizeToContent="WidthAndHeight"
        FontFamily="Segoe UI" Foreground="White">
  <Window.Resources>
    <Style x:Key="IconButton" TargetType="Button">
      <Setter Property="FontFamily" Value="Segoe Fluent Icons, Segoe MDL2 Assets"/>
      <Setter Property="FontSize" Value="11"/>
      <Setter Property="Width" Value="26"/>
      <Setter Property="Height" Value="22"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Foreground" Value="{Binding Foreground, RelativeSource={RelativeSource AncestorType=Window}}"/>
      <Setter Property="Opacity" Value="0.6"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Bg" Background="Transparent" CornerRadius="11">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Bg" Property="Background" Value="#22808080"/>
                <Setter Property="Opacity" Value="1"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Border x:Name="Card" CornerRadius="24" BorderThickness="1" Padding="14,12,14,14" Margin="18">
    <Border.Effect><DropShadowEffect BlurRadius="32" ShadowDepth="8" Direction="270" Opacity="0.16"/></Border.Effect>
    <Border.LayoutTransform><ScaleTransform x:Name="Zoom" ScaleX="1" ScaleY="1"/></Border.LayoutTransform>
    <StackPanel>
      <DockPanel Margin="2,0,0,4">
        <StackPanel DockPanel.Dock="Right" Orientation="Horizontal" VerticalAlignment="Center">
          <Button x:Name="PaletteBtn" Style="{StaticResource IconButton}" Content="&#xE790;" ToolTip="Change colours"/>
          <Button x:Name="PinBtn" Style="{StaticResource IconButton}"/>
          <Button x:Name="MinBtn" Style="{StaticResource IconButton}" Content="&#xE921;" ToolTip="Minimize"/>
        </StackPanel>
        <TextBlock FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" Text="&#xE774;" FontSize="13"
                   VerticalAlignment="Center" Margin="2,1,8,0" Opacity="0.7"/>
        <TextBlock x:Name="Title" Text="Around the world" FontFamily="Segoe UI Variable Display, Segoe UI" FontSize="13"
                   FontWeight="SemiBold" VerticalAlignment="Center" Opacity="0.85"/>
      </DockPanel>
      <StackPanel x:Name="Rows" MinWidth="280"/>
      <Popup x:Name="ThemePopup" PlacementTarget="{Binding ElementName=PaletteBtn}" Placement="Bottom"
             StaysOpen="False" AllowsTransparency="True" PopupAnimation="Fade" HorizontalOffset="-150">
        <Border Background="#F2FFFFFF" CornerRadius="16" Padding="12,10" Margin="8">
          <Border.Effect><DropShadowEffect BlurRadius="16" ShadowDepth="2" Opacity="0.3"/></Border.Effect>
          <StackPanel>
            <TextBlock Text="Pick a vibe" FontFamily="Segoe UI Variable Display, Segoe UI" FontSize="14" FontWeight="SemiBold"
                       Foreground="#1D1D1F" Margin="2,0,0,8"/>
            <WrapPanel x:Name="Swatches" Width="294"/>
          </StackPanel>
        </Border>
      </Popup>
    </StackPanel>
  </Border>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$card = $window.FindName('Card')
$zoom = $window.FindName('Zoom')
$rowsPanel = $window.FindName('Rows')
$pinBtn = $window.FindName('PinBtn')
$minBtn = $window.FindName('MinBtn')
$themePopup = $window.FindName('ThemePopup')
$swatchPanel = $window.FindName('Swatches')
$script:config = Get-Config
$script:rows = @()

$pinBtn.Add_Click({ Set-Setting 'Topmost' (-not [bool]$script:config.Topmost) })
$minBtn.Add_Click({ $window.WindowState = 'Minimized' })
$window.FindName('PaletteBtn').Add_Click({ $themePopup.IsOpen = -not $themePopup.IsOpen })

function New-Brush([string]$hex, [double]$alpha = 1) {
    $c = [Windows.Media.ColorConverter]::ConvertFromString($hex)
    New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromArgb([byte]($c.A * $alpha), $c.R, $c.G, $c.B))
}

function New-ThemeBrush([string]$name, [double]$alpha = 1) {
    $stops = $themes[$name].Stops
    $grad = New-Object Windows.Media.LinearGradientBrush
    $grad.StartPoint = '0,0'
    $grad.EndPoint = '1,1'
    for ($s = 0; $s -lt $stops.Count; $s++) {
        $c = (New-Brush $stops[$s] $alpha).Color
        $grad.GradientStops.Add((New-Object Windows.Media.GradientStop $c, ($s / ($stops.Count - 1))))
    }
    $grad
}

# Colour picker popup: one gradient bubble per theme, current one ringed
function Build-Swatches {
    $swatchPanel.Children.Clear()
    foreach ($name in $themes.Keys) {
        $isCurrent = $name -eq $script:config.Theme
        $item = New-Object System.Windows.Controls.StackPanel
        $item.Width = 49
        $item.Margin = '0,0,0,6'
        $item.Cursor = 'Hand'
        $item.Tag = $name
        $item.Background = [Windows.Media.Brushes]::Transparent
        $dot = New-Object System.Windows.Controls.Border
        $dot.Width = $dot.Height = 34
        $dot.CornerRadius = 17
        $dot.Background = New-ThemeBrush $name
        $dot.BorderBrush = if ($isCurrent) { New-Brush '#1D1D1F' } else { New-Brush '#000000' 0.12 }
        $dot.BorderThickness = if ($isCurrent) { 2 } else { 1 }
        $label = New-Object System.Windows.Controls.TextBlock
        $label.Text = $name
        $label.FontSize = 10
        $label.Foreground = New-Brush '#1D1D1F' $(if ($isCurrent) { 1 } else { 0.6 })
        $label.FontWeight = if ($isCurrent) { 'SemiBold' } else { 'Normal' }
        $label.HorizontalAlignment = 'Center'
        $label.Margin = '0,2,0,0'
        [void]$item.Children.Add($dot)
        [void]$item.Children.Add($label)
        $item.Add_MouseLeftButtonUp({ Set-Setting 'Theme' $this.Tag })
        [void]$swatchPanel.Children.Add($item)
    }
}

# Taskbar / Alt+Tab icon: soft indigo clock face
$iconVisual = New-Object Windows.Media.DrawingVisual
$dc = $iconVisual.RenderOpen()
$center = New-Object Windows.Point 32, 32
$iconFill = New-Object Windows.Media.LinearGradientBrush (
    [Windows.Media.ColorConverter]::ConvertFromString('#7F9CF5')),
    ([Windows.Media.ColorConverter]::ConvertFromString('#B794F4')), 45
$dc.DrawEllipse($iconFill, $null, $center, 30, 30)
$hand = New-Object Windows.Media.Pen ([Windows.Media.Brushes]::White), 5
$hand.StartLineCap = $hand.EndLineCap = 'Round'
$dc.DrawLine($hand, $center, (New-Object Windows.Point 32, 12))
$dc.DrawLine($hand, $center, (New-Object Windows.Point 46, 38))
$dc.Close()
$iconBitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap 64, 64, 96, 96, ([Windows.Media.PixelFormats]::Pbgra32)
$iconBitmap.Render($iconVisual)
$window.Icon = $iconBitmap

function Build-Rows {
    $rowsPanel.Children.Clear()
    $script:rows = @()
    $p = $palettes[$themes[$script:config.Theme].Mode]
    $i = 0
    foreach ($c in $script:config.Clocks) {
        try { $tz = [TimeZoneInfo]::FindSystemTimeZoneById($c.Zone) }
        catch { continue }
        $accent = $accents[$i % $accents.Count]
        $i++

        # Frosted-glass row card
        $bubble = New-Object System.Windows.Controls.Border
        $bubble.CornerRadius = 16
        $bubble.Background = New-Brush $p.Row[0] $p.Row[1]
        $bubble.BorderBrush = New-Brush $p.RowBorder[0] $p.RowBorder[1]
        $bubble.BorderThickness = 1
        $bubble.Padding = '12,10,14,10'
        $bubble.Margin = '0,6,0,0'
        $stack = New-Object System.Windows.Controls.StackPanel
        $bubble.Child = $stack

        $dock = New-Object System.Windows.Controls.DockPanel

        # Sun / moon badge, tinted for day or night in Update-Rows
        $badge = New-Object System.Windows.Controls.Border
        $badge.Width = $badge.Height = 34
        $badge.CornerRadius = 17
        $badge.Margin = '0,0,12,0'
        $badge.VerticalAlignment = 'Center'
        $glyph = New-Object System.Windows.Controls.TextBlock
        $glyph.FontFamily = 'Segoe Fluent Icons, Segoe MDL2 Assets'
        $glyph.FontSize = 15
        $glyph.HorizontalAlignment = $glyph.VerticalAlignment = 'Center'
        $badge.Child = $glyph
        [System.Windows.Controls.DockPanel]::SetDock($badge, 'Left')

        $time = New-Object System.Windows.Controls.TextBlock
        $time.FontFamily = 'Segoe UI Variable Display, Segoe UI'
        $time.FontSize = 30
        $time.FontWeight = 'Light'
        $time.Margin = '18,0,0,0'
        $time.VerticalAlignment = 'Center'
        $mainRun = New-Object System.Windows.Documents.Run
        $suffixRun = New-Object System.Windows.Documents.Run
        $suffixRun.FontSize = 12
        $suffixRun.FontWeight = 'SemiBold'
        $suffixRun.Foreground = New-Brush $p.Sub
        $time.Inlines.Add($mainRun)
        $time.Inlines.Add($suffixRun)
        [System.Windows.Controls.DockPanel]::SetDock($time, 'Right')

        $left = New-Object System.Windows.Controls.StackPanel
        $left.VerticalAlignment = 'Center'
        $city = New-Object System.Windows.Controls.TextBlock
        $city.Text = $c.Label
        $city.FontFamily = 'Segoe UI Variable Display, Segoe UI'
        $city.FontSize = 14.5
        $city.FontWeight = 'SemiBold'
        $vibe = New-Object System.Windows.Controls.TextBlock
        $vibe.FontSize = 11.5
        $vibe.Foreground = New-Brush $p.Vibe
        $sub = New-Object System.Windows.Controls.TextBlock
        $sub.FontSize = 10.5
        $sub.Foreground = New-Brush $p.Sub
        [void]$left.Children.Add($city)
        [void]$left.Children.Add($vibe)
        [void]$left.Children.Add($sub)

        [void]$dock.Children.Add($badge)
        [void]$dock.Children.Add($time)
        [void]$dock.Children.Add($left)
        [void]$stack.Children.Add($dock)

        # Day-progress bar: how far through their day this city is
        $track = New-Object System.Windows.Controls.Border
        $track.Height = 4
        $track.CornerRadius = 2
        $track.Background = New-Brush $p.Track[0] $p.Track[1]
        $track.Margin = '46,8,0,0'
        $barGrid = New-Object System.Windows.Controls.Grid
        $fillCol = New-Object System.Windows.Controls.ColumnDefinition
        $restCol = New-Object System.Windows.Controls.ColumnDefinition
        [void]$barGrid.ColumnDefinitions.Add($fillCol)
        [void]$barGrid.ColumnDefinitions.Add($restCol)
        $fill = New-Object System.Windows.Controls.Border
        $fill.CornerRadius = 2
        $fill.Background = New-Brush $accent
        [void]$barGrid.Children.Add($fill)
        $track.Child = $barGrid
        $track.ToolTip = 'How much of their day is done'
        [void]$stack.Children.Add($track)

        if (-not $script:config.ShowDetails) { $sub.Visibility = $track.Visibility = 'Collapsed' }
        [void]$rowsPanel.Children.Add($bubble)

        $script:rows += [pscustomobject]@{
            Tz = $tz; Main = $mainRun; Suffix = $suffixRun; Sub = $sub; Vibe = $vibe; Glyph = $glyph; Badge = $badge
            FillCol = $fillCol; RestCol = $restCol
            DayBg = New-Brush $p.DayBg; DayFg = New-Brush $p.DayFg; NightBg = New-Brush $p.NightBg; NightFg = New-Brush $p.NightFg
        }
    }
    Update-Rows
}

function Update-Rows {
    $nowUtc = [DateTime]::UtcNow
    $localDate = [DateTime]::Now.Date
    $fmt = if ($script:config.Use24h) { 'HH:mm' } else { 'h:mm' }
    if ($script:config.ShowSeconds) { $fmt += ':ss' }
    foreach ($r in $script:rows) {
        $t = [TimeZoneInfo]::ConvertTimeFromUtc($nowUtc, $r.Tz)
        $r.Main.Text = $t.ToString($fmt, $enUS)
        $r.Suffix.Text = if ($script:config.Use24h) { '' } else { ' ' + $t.ToString('tt', $enUS) }
        $isDay = $t.Hour -ge 6 -and $t.Hour -lt 18
        $r.Glyph.Text = if ($isDay) { [char]0xE706 } else { [char]0xE708 }
        $r.Glyph.Foreground = if ($isDay) { $r.DayFg } else { $r.NightFg }
        $r.Badge.Background = if ($isDay) { $r.DayBg } else { $r.NightBg }
        $r.Vibe.Text = Get-Vibe $t.Hour
        $day = switch (($t.Date - $localDate).Days) { 0 { 'Today' } 1 { 'Tomorrow' } -1 { 'Yesterday' } }
        $off = $r.Tz.GetUtcOffset($nowUtc)
        $sign = if ($off -lt [TimeSpan]::Zero) { '-' } else { '+' }
        $r.Sub.Text = '{0}, {1} {4} UTC{2}{3:hh\:mm}' -f $day, $t.ToString('ddd d MMM', $enUS), $sign, $off.Duration(), [char]0x00B7
        $frac = [Math]::Max($t.TimeOfDay.TotalHours / 24, 0.001)
        $r.FillCol.Width = New-Object System.Windows.GridLength $frac, 'Star'
        $r.RestCol.Width = New-Object System.Windows.GridLength (1 - $frac), 'Star'
    }
}

function Apply-Settings {
    $p = $palettes[$themes[$script:config.Theme].Mode]
    $card.Background = New-ThemeBrush $script:config.Theme ([double]$script:config.Opacity)
    $card.BorderBrush = New-Brush $p.CardBorder[0] $p.CardBorder[1]
    $window.Foreground = New-Brush $p.Fg
    Build-Swatches
    $zoom.ScaleX = $zoom.ScaleY = [double]$script:config.Scale
    $window.Topmost = [bool]$script:config.Topmost
    # Pinned = filled pin glyph; unpinned = outline pin
    $pinBtn.Content = if ($window.Topmost) { [char]0xE842 } else { [char]0xE718 }
    $pinBtn.ToolTip = if ($window.Topmost) { 'Unpin (stop staying on top)' } else { 'Pin on top of other apps' }
    Build-Rows
    Build-Menu
}

function Set-Setting($name, $value) {
    $script:config.$name = $value
    Apply-Settings
    Save-Config
}

# --- Context menu ---------------------------------------------------------

function New-MenuItem($header, $checked = $false, $tag = $null) {
    $mi = New-Object System.Windows.Controls.MenuItem
    $mi.Header = $header
    $mi.IsChecked = $checked
    $mi.Tag = $tag
    $mi
}

# Radio-style choice: Tag = @(settingName, value)
function Add-Choice($parent, $header, $name, $value) {
    $mi = New-MenuItem $header ($script:config.$name -eq $value) @($name, $value)
    $mi.Add_Click({ Set-Setting $this.Tag[0] $this.Tag[1] })
    [void]$parent.Items.Add($mi)
}

# On/off toggle: Tag = settingName
function Add-Toggle($parent, $header, $name) {
    $mi = New-MenuItem $header ([bool]$script:config.$name) $name
    $mi.Add_Click({ Set-Setting $this.Tag (-not [bool]$script:config.($this.Tag)) })
    [void]$parent.Items.Add($mi)
}

function Build-Menu {
    $menu = New-Object System.Windows.Controls.ContextMenu

    $add = New-MenuItem 'Add a city...'
    $add.Add_Click({ Show-AddCityDialog })
    [void]$menu.Items.Add($add)

    $remove = New-MenuItem 'Say bye to a city'
    foreach ($c in $script:config.Clocks) {
        $mi = New-MenuItem $c.Label $false $c
        $mi.Add_Click({
            $target = $this.Tag
            $script:config.Clocks = @($script:config.Clocks | Where-Object { -not [object]::ReferenceEquals($_, $target) })
            Apply-Settings
            Save-Config
        })
        [void]$remove.Items.Add($mi)
    }
    $remove.IsEnabled = $remove.Items.Count -gt 0
    [void]$menu.Items.Add($remove)
    [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))

    $theme = New-MenuItem 'Colour theme'
    foreach ($t in $themes.Keys) { Add-Choice $theme $t 'Theme' $t }
    [void]$menu.Items.Add($theme)

    $format = New-MenuItem 'Time format'
    Add-Choice $format '12-hour (3:45 PM)' 'Use24h' $false
    Add-Choice $format '24-hour (15:45)' 'Use24h' $true
    [void]$menu.Items.Add($format)
    Add-Toggle $menu 'Show seconds' 'ShowSeconds'
    Add-Toggle $menu 'Show date & day progress' 'ShowDetails'

    $size = New-MenuItem 'Size'
    Add-Choice $size 'Small' 'Scale' 0.8
    Add-Choice $size 'Medium' 'Scale' 1.0
    Add-Choice $size 'Large' 'Scale' 1.25
    Add-Choice $size 'Extra large' 'Scale' 1.5
    [void]$menu.Items.Add($size)

    $opacity = New-MenuItem 'Background opacity'
    foreach ($o in 1.0, 0.95, 0.85, 0.7, 0.5) { Add-Choice $opacity ('{0:P0}' -f $o) 'Opacity' $o }
    [void]$menu.Items.Add($opacity)
    [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))

    Add-Toggle $menu 'Pin on top' 'Topmost'
    $minimize = New-MenuItem 'Minimize'
    $minimize.Add_Click({ $window.WindowState = 'Minimized' })
    [void]$menu.Items.Add($minimize)
    Add-Toggle $menu 'Lock position' 'Locked'
    $startup = New-MenuItem 'Start with Windows' (Test-Path $startupLink)
    $startup.Add_Click({ Set-Startup (-not (Test-Path $startupLink)); Build-Menu })
    [void]$menu.Items.Add($startup)
    [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))

    $edit = New-MenuItem 'Edit config file...'
    $edit.Add_Click({ Start-Process notepad.exe -ArgumentList "`"$configPath`"" })
    [void]$menu.Items.Add($edit)
    $reload = New-MenuItem 'Reload config'
    $reload.Add_Click({ $script:config = Get-Config; Apply-Settings })
    [void]$menu.Items.Add($reload)
    $exit = New-MenuItem 'Exit (see ya!)'
    $exit.Add_Click({ $window.Close() })
    [void]$menu.Items.Add($exit)

    $window.ContextMenu = $menu
}

function Set-Startup($enable) {
    if ($enable) {
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($startupLink)
        $lnk.TargetPath = 'wscript.exe'
        $lnk.Arguments = "`"$launcherPath`""
        $lnk.WorkingDirectory = $PSScriptRoot
        $lnk.Save()
    } elseif (Test-Path $startupLink) {
        Remove-Item $startupLink
    }
}

# --- Add city dialog ------------------------------------------------------

function Show-AddCityDialog {
    [xml]$dlgXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Add a city" SizeToContent="WidthAndHeight" ResizeMode="NoResize"
        WindowStartupLocation="CenterScreen" Topmost="True" FontFamily="Segoe UI" FontSize="13">
  <StackPanel Margin="16" Width="380">
    <TextBlock Text="Where in the world?" FontFamily="Bahnschrift" FontSize="18" FontWeight="SemiBold" Margin="0,0,0,10"/>
    <TextBlock Text="Time zone" Margin="0,0,0,4"/>
    <ComboBox x:Name="Zone" DisplayMemberPath="DisplayName" IsEditable="True" IsTextSearchEnabled="True"/>
    <TextBlock Text="Nickname (e.g. Mom's place, HQ, Paris)" Margin="0,12,0,4"/>
    <TextBox x:Name="Label" Padding="3"/>
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,16,0,0">
      <Button x:Name="Ok" Content="Add it!" Width="80" IsDefault="True" Margin="0,0,8,0"/>
      <Button Content="Nah" Width="80" IsCancel="True"/>
    </StackPanel>
  </StackPanel>
</Window>
'@
    $dlg = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $dlgXaml))
    $zoneBox = $dlg.FindName('Zone')
    $labelBox = $dlg.FindName('Label')
    $zoneBox.ItemsSource = [TimeZoneInfo]::GetSystemTimeZones()
    $zoneBox.SelectedItem = $zoneBox.ItemsSource | Where-Object Id -eq ([TimeZoneInfo]::Local.Id) | Select-Object -First 1
    $dlg.FindName('Ok').Add_Click({ [System.Windows.Window]::GetWindow($this).DialogResult = $true })
    $labelBox.Focus() | Out-Null

    if ($dlg.ShowDialog() -and $zoneBox.SelectedItem) {
        $tz = $zoneBox.SelectedItem
        $label = $labelBox.Text.Trim()
        if (-not $label) { $label = $tz.StandardName }
        $script:config.Clocks = @($script:config.Clocks) + [pscustomobject]@{ Label = $label; Zone = $tz.Id }
        Apply-Settings
        Save-Config
    }
}

# --- Startup --------------------------------------------------------------

# Position clamped to visible desktop
$vsL = [System.Windows.SystemParameters]::VirtualScreenLeft
$vsT = [System.Windows.SystemParameters]::VirtualScreenTop
$vsR = $vsL + [System.Windows.SystemParameters]::VirtualScreenWidth - 80
$vsB = $vsT + [System.Windows.SystemParameters]::VirtualScreenHeight - 80
$window.Left = [Math]::Min([Math]::Max([double]$script:config.Left, $vsL), $vsR)
$window.Top = [Math]::Min([Math]::Max([double]$script:config.Top, $vsT), $vsB)

# Drag anywhere (unless locked); DragMove blocks until mouse release, then persist position
$window.Add_MouseLeftButtonDown({
    if ($script:config.Locked) { return }
    $window.DragMove()
    Save-Config
})

Apply-Settings

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({ Update-Rows })
$timer.Start()

$window.Add_Closed({ $timer.Stop() })
[void]$window.ShowDialog()
