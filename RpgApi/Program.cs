var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.UseStaticFiles();

var maps = new Dictionary<string, object>();

app.MapGet("/maps", () => maps.Keys);
app.MapGet("/maps/{name}", (string name) =>
    maps.TryGetValue(name, out var map) ? Results.Ok(map) : Results.NotFound());
app.MapPost("/maps/{name}", async (string name, HttpRequest req) => {
    var body = await new StreamReader(req.Body).ReadToEndAsync();
    maps[name] = System.Text.Json.JsonSerializer.Deserialize<object>(body)!;
    return Results.Ok();
});

// Lets the editor overwrite scenario files (scripts, scenario.json) in place.
app.MapPost("/scenarios/{**path}", async (string path, HttpRequest req, IWebHostEnvironment env) => {
    var root = Path.GetFullPath(Path.Combine(env.WebRootPath, "scenarios"));
    var full = Path.GetFullPath(Path.Combine(root, path));
    if (!full.StartsWith(root + Path.DirectorySeparatorChar) || !full.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        return Results.BadRequest();

    var body = await new StreamReader(req.Body).ReadToEndAsync();
    try { System.Text.Json.JsonDocument.Parse(body).Dispose(); }
    catch (System.Text.Json.JsonException) { return Results.BadRequest(); }

    Directory.CreateDirectory(Path.GetDirectoryName(full)!);
    await File.WriteAllTextAsync(full, body);
    return Results.Ok();
});

app.Run();