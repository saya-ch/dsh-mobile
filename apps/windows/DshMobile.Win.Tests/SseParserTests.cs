using Xunit;

namespace DshMobile.Win.Tests;

public class SseParserTests
{
    [Fact]
    public void DispatchesTaskNotifyWithJsonBody()
    {
        var parser = new SseParser();
        Assert.Null(parser.FeedLine("event: task-notify"));
        Assert.Null(parser.FeedLine("data: {\"sessionId\":\"abc\",\"turn\":3,\"title\":\"t\",\"body\":\"b\"}"));
        var notification = parser.FeedLine(string.Empty);
        Assert.NotNull(notification);
        Assert.Equal("task-notify", notification.Event);
        Assert.Contains("\"turn\":3", notification.Data);
    }

    [Fact]
    public void IgnoresHeartbeatsAndUnknownEvents()
    {
        var parser = new SseParser();
        Assert.Null(parser.FeedLine(": heartbeat"));
        Assert.Null(parser.FeedLine("retry: 2000"));
        Assert.Null(parser.FeedLine(string.Empty));
        Assert.Null(parser.FeedLine("event: extensions-changed"));
        Assert.Null(parser.FeedLine("data: {}"));
        var notification = parser.FeedLine(string.Empty);
        Assert.NotNull(notification);
        Assert.Equal("extensions-changed", notification.Event);
    }

    [Fact]
    public void DispatchesDeviceRevoked()
    {
        var parser = new SseParser();
        parser.FeedLine("event: device-revoked");
        parser.FeedLine("data: {\"reason\":\"revoked\"}");
        var notification = parser.FeedLine(string.Empty);
        Assert.NotNull(notification);
        Assert.Equal("device-revoked", notification.Event);
    }

    [Fact]
    public void DataWithoutEvent_IsDropped()
    {
        var parser = new SseParser();
        parser.FeedLine("data: {}");
        Assert.Null(parser.FeedLine(string.Empty));
    }

    [Fact]
    public void JoinsMultilineData()
    {
        var parser = new SseParser();
        parser.FeedLine("event: task-notify");
        parser.FeedLine("data: {\"a\":1,");
        parser.FeedLine("data: \"b\":2}");
        var notification = parser.FeedLine(string.Empty);
        Assert.NotNull(notification);
        Assert.Equal("{\"a\":1,\n\"b\":2}", notification.Data);
    }
}
