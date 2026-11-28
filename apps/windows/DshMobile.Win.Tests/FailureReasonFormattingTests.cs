using System;
using DshMobile.Win;
using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// The failure message template supplies its own full stop, so the reason must not bring one.
/// </summary>
/// <remarks>
/// This is what produced "请稍后重试。。可以稍后重试" in the settings footer: the rate-limit copy ended
/// its own sentence, the template added another, and both offered the same advice. Resource
/// values are written without a stop, but the catch-all branch passes an exception message
/// through, and that can come from anywhere.
/// </remarks>
public class FailureReasonFormattingTests
{
    [Theory]
    [InlineData("GitHub is limiting requests", "GitHub is limiting requests")]
    [InlineData("GitHub is limiting requests.", "GitHub is limiting requests")]
    [InlineData("请求超时（15 秒内没有响应）。", "请求超时（15 秒内没有响应）")]
    [InlineData("请求超时（15 秒内没有响应）。。", "请求超时（15 秒内没有响应）")]
    [InlineData("Trailing dot and spaces.  ", "Trailing dot and spaces")]
    [InlineData("A sentence. And another.", "A sentence. And another")]
    public void ATerminalFullStopIsRemoved(string input, string expected)
    {
        Assert.Equal(expected, UpdatePayload.WithoutTerminalStop(input));
    }

    [Fact]
    public void AReasonWithoutAStopIsLeftAlone()
    {
        // Inner punctuation is part of the sentence and must survive.
        const string reason = "找不到发布页，该版本可能已被移除";
        Assert.Equal(reason, UpdatePayload.WithoutTerminalStop(reason));
    }

    [Fact]
    public void AnEmptyReasonDoesNotThrow()
    {
        Assert.Equal(string.Empty, UpdatePayload.WithoutTerminalStop(string.Empty));
        Assert.Equal(string.Empty, UpdatePayload.WithoutTerminalStop("   "));
        Assert.Equal(string.Empty, UpdatePayload.WithoutTerminalStop("。"));
    }
}