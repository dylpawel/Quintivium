Add-Type -AssemblyName System.Drawing

# 1. Your exact list of files
$files = "Knight.png", "Orc.png", "OrcRogue.png", "OrcShaman.png", "OrcWarrior.png", 
         "Rogue.png", "Skeleton.png", "SkeletonMage.png", "SkeletonRogue.png", "SkeletonWarrior.png", "Wizard.png"

# 2. Open the first image to automatically grab the correct width and height
$firstBmp = [System.Drawing.Bitmap]::FromFile("$pwd/$($files[0])")
$w = $firstBmp.Width
$h = $firstBmp.Height
$firstBmp.Dispose()

# 3. Create the blank canvas (Total height = height of 1 file * number of files)
$canvas = New-Object System.Drawing.Bitmap($w, ($h * $files.Count))
$g = [System.Drawing.Graphics]::FromImage($canvas)

# 4. Draw them one below the other
for ($i = 0; $i -lt $files.Count; $i++) {
    $bmp = [System.Drawing.Bitmap]::FromFile("$pwd/$($files[$i])")
    $g.DrawImage($bmp, 0, ($i * $h))
    $bmp.Dispose()
}

# 5. Save the final pixel-perfect sprite sheet
$canvas.Save("$pwd/Enemies.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $canvas.Dispose()

Write-Host "Done! Created Enemies.png" -ForegroundColor Green