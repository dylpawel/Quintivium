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

app.Run();